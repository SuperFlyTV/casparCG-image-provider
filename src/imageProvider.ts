import { config, ChannelSetup } from './config'
import { CasparCG, AMCP } from 'casparcg-connection'
import * as fs from 'fs'
import * as util from 'util'
import * as _ from 'underscore'
import * as path from 'path'
import sharp = require('sharp')

const fsAccess = util.promisify(fs.access)
const fsExists = util.promisify(fs.exists)
const fsUnlink = util.promisify(fs.unlink)
const fsReadFile = util.promisify(fs.readFile)

const ticCache = {}
export function tic (name: string = 'default') {
	ticCache[name] = Date.now()
}
export function toc (name: string = 'default', logStr?: string) {

	if (_.isArray(logStr)) {
		_.each(logStr, (promise, i) => {
			promise.then((result) => {
				toc(name, 'Promise ' + i)
				return result
			})
			.catch(e => {
				throw e
			})
		})
	} else {
		let t: number = Date.now() - ticCache[name]
		if (logStr) console.log('toc: ' + name + ': ' + logStr + ': ' + t)
		// return t
	}
}

export class ImageProvider {
	casparcg: CasparCG

	mediaPath: string
	private _takenRegions: {[regionId: string]: true} = {}
	private _regionRoutes: {[routeId: string]: RegionRoute} = {}
	private _snapshots: {[channel: string]: Promise<Snapshot>} = {}
	private _fileIterator: number = 0

	constructor () {
		this.casparcg = new CasparCG(config.host, config.port)
	}

	async init () {

		const casparConfig = await this.casparcg.infoConfig()

		this.mediaPath = casparConfig.response.data.paths.mediaPath
		if (!this.mediaPath) throw new Error('Unable to get media path from casparCG')

		console.log(`CasparCG media path: "${this.mediaPath}"`)
		// test accessibility:
		fsAccess(this.mediaPath)

		// Reset casparCG channels on startup:
		_.each(config.channels, channel => {
			this.casparcg.clear(channel.channel)
		})
	}

	async getImage (channel: number, layer?: number) {

		const route = await this.getRegionRoute(channel, layer)

		if (!route) return null

		const snapshot = await this.fetchSnapshot(route)

		await this.waitForFile(snapshot.filePath)
		await this.wait(500) // wait a bit more for the write to finish

		const buf = await fsReadFile(snapshot.filePath)

		const image = await sharp(buf)
			.extract({
				left: route.region.x,
				top: route.region.y,
				width: route.region.width,
				height: route.region.height
			})
			.png()

		return image
	}

	private async getRegionRoute (channel: number, layer?: number): Promise<RegionRoute | undefined> {
		const id = this.getRouteId(channel, layer)

		const route: RegionRoute = this._regionRoutes[id]

		if (!route) {
			const newRoute: RegionRoute | undefined = await this.createNewRegionRoute(channel, layer)

			return newRoute
		} else {
			return route
		}
	}
	private async createNewRegionRoute (channel: number, layer?: number): Promise<RegionRoute | undefined> {

		const id = this.getRouteId(channel, layer)
		console.log('Creating new region route', id, channel, layer)

		// find first free region
		let foundRegion: Region | undefined = _.find(this.getAvailableRegions(), (region: Region) => {
			return !this._takenRegions[region.id]
		})

		if (foundRegion) {
			this._takenRegions[foundRegion.id] = true

			const route: RegionRoute = {
				region: foundRegion,
				channel: channel,
				layer: layer
			}
			this._regionRoutes[id] = route

			// console.log('foundRegion', foundRegion)
			// console.log('route', route)

			// Route the layer to the region:
			await this.casparCGRoute(
				foundRegion.channel,
				foundRegion.layer,
				route.channel,
				route.layer
			)
			await this.casparcg.mixerFill(
				foundRegion.channel,
				foundRegion.layer,
				foundRegion.x / foundRegion.originalWidth,
				foundRegion.y / foundRegion.originalHeight,
				foundRegion.width / foundRegion.originalWidth,
				foundRegion.height / foundRegion.originalHeight
			)

			return route
		}
		return undefined
	}
	private getAvailableRegions (): Region[] {
		const regions: Region[] = []

		_.each(config.channels, (channel: ChannelSetup) => {
			let i: number = 0
			for (let x = 0; x < channel.resolution; x++) {
				for (let y = 0; y < channel.resolution; y++) {
					const width = Math.floor(channel.width / channel.resolution)
					const height = Math.floor(channel.height / channel.resolution)
					i++

					const region: Region = {
						id: `${channel.channel}_${x}_${y}`,
						channel: channel.channel,
						layer: 10 * i,
						x: x * width,
						y: y * height,
						width: width,
						height: height,

						originalWidth: channel.width,
						originalHeight: channel.height

					}
					regions.push(region)
				}
			}
		})
		return regions
	}
	private getRouteId (channel: number, layer?: number) {
		if (layer) return `l_${channel}_${layer}`
		return `c_${channel}`
	}
	private async fetchSnapshot (route: RegionRoute): Promise<Snapshot> {

		const channelId = route.region.channel + ''
		// First, check if we have a not-too-old stored snapshot of it?
		const snapshot = await this._snapshots[channelId]
		if (snapshot) {

			if (snapshot.timestamp + config.snapshotTimeout > Date.now()) {
				return snapshot
			} else {
				// the snapshot is too old

				delete this._snapshots[channelId]
				// todo: remove snapshot on disk?
			}
		}
		this._snapshots[channelId] = (async (): Promise<Snapshot> => {
			// Renew snapshot:
			const i = this._fileIterator++
			if (this._fileIterator > config.maxFileCount) {
				this._fileIterator = 0
			}
			const filename = `snap_${i}`
			const timestamp = Date.now()

			const localFilePath = path.join(config.mediaFolderName || '', filename)
			const filePath = path.join(this.mediaPath, localFilePath + '.png')

			if (await fsExists(filePath)) {
				// remove it first
				await fsUnlink(filePath)
			}

			await this.casparCGPrint(route.region.channel, localFilePath.replace(/\\/g, '/'))

			await this.waitForFile(filePath)
			// todo: maybe wait until file appears here?

			return {
				timestamp: timestamp,
				filePath: filePath
			}
		})()
		return this._snapshots[channelId]
	}
	private async waitForFile (filePath: string) {
		for (let i = 0; i < 10; i++) {
			if (await fsExists(filePath)) break
			await this.wait(100)
		}
	}

	private wait (time: number) {
		return new Promise(resolve => setTimeout(resolve, time))
	}
	private casparCGPrint (channel: number, fileName: string) {
		this.casparcg.do(
			new AMCP.CustomCommand({
				channel: channel,
				command: (
					`ADD ${channel} IMAGE "${fileName}"`
				)
			})
		)
	}
	private casparCGRoute (
		channel: number,
		layer: number,
		routeChannel: number,
		routeLayer?: number
	) {
		this.casparcg.do(
			new AMCP.CustomCommand({
				channel: channel,
				command: (
					`PLAY ${channel}-${layer} route://${routeChannel + (routeLayer ? '-' + routeLayer : '')}`
				)
			})
		)
	}
}
interface Region {
	id: string
	channel: number
	layer: number
	x: number
	y: number
	width: number
	height: number

	originalWidth: number
	originalHeight: number
}
interface RegionRoute {
	region: Region
	channel: number
	layer?: number
}
interface Snapshot {
	timestamp: number
	filePath: string
}
