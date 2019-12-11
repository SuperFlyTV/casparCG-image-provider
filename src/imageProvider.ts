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
const fsStat = util.promisify(fs.stat)

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
	private _snapshots: {[channel: string]: Snapshot} = {}
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
		await fsAccess(this.mediaPath)

		// Reset casparCG channels on startup:
		await Promise.all(
			_.map(config.channels, channel => {
				return this.casparcg.clear(channel.channel)
			})
		)
	}

	async getImage (channel: number, layer?: number) {
		const route = await this.getRegionRoute(channel, layer)

		if (!route) return null

		const snapshotData = await this.fetchSnapshotData(route)

		// await this.waitForFile(snapshot.filePath)
		// await this.wait(500) // wait a bit more for the write to finish

		const image = sharp(snapshotData)
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
	private async fetchSnapshotData (route: RegionRoute): Promise<Buffer> {
		const channelId = route.region.channel + ''
		// First, check if we have a not-too-old stored snapshot of it?
		const snapshot = this._snapshots[channelId]
		if (snapshot) {

			if (snapshot.timestamp + config.snapshotTimeout > Date.now()) {
				let data = await snapshot.data
				return data
			} else {
				// the snapshot is too old

				delete this._snapshots[channelId]
				// todo: remove snapshot on disk?
			}
		}

		// Renew snapshot:
		const i = this._fileIterator++
		if (this._fileIterator > config.maxFileCount) {
			this._fileIterator = 0
		}
		const filename = `snap_${i}`
		const timestamp = Date.now()

		const localFilePath = path.join(config.mediaFolderName || '', filename)
		const filePath = path.join(this.mediaPath, localFilePath + '.png')

		this._snapshots[channelId] = {
			timestamp: timestamp,
			filePath: filePath,
			data: (async (filePath: string): Promise<Buffer> => {

				if (await fsExists(filePath)) {
					// remove it first
					await fsUnlink(filePath)
				}
				await this.casparCGPrint(route.region.channel, localFilePath.replace(/\\/g, '/'))

				await this.waitForFile(filePath)
				// todo: maybe wait until file appears here?

				// await this.wait(500) // wait a bit more for the write to finish

				const fileData = await fsReadFile(filePath)

				return fileData
			})(filePath)
		}

		const data = await this._snapshots[channelId].data
		return data
	}
	private async waitForFile (filePath: string) {
		// const startTime = Date.now()
		for (let i = 0; i < 30; i++) {
			if (await fsExists(filePath)) break
			await this.wait(50)
		}
		// console.log('File appeared after', Date.now() - startTime)
		// At this point, we've estabilshed that the file exists.
		// Now, let's wait until the file size stops growing
		let fileSize = 0
		for (let i = 0; i < 30; i++) {
			const stat = await fsStat(filePath)
			if (stat.size !== fileSize) {
				fileSize = stat.size
				await this.wait(50)
			} else break
		}
		// console.log('File stopped growing after', Date.now() - startTime)
	}

	private wait (time: number) {
		return new Promise(resolve => setTimeout(resolve, time))
	}
	private async casparCGPrint (channel: number, fileName: string) {
		await this.casparcg.do(
			new AMCP.CustomCommand({
				channel: channel,
				command: (
					`ADD ${channel} IMAGE "${fileName}"`
				)
			})
		)
	}
	private async casparCGRoute (
		channel: number,
		layer: number,
		routeChannel: number,
		routeLayer?: number
	) {
		await this.casparcg.do(
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
	data: Promise<Buffer>
}
