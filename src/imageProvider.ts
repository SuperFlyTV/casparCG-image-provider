import * as Koa from 'koa'
import * as _ from 'underscore'
import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'

import { AMCP, CasparCG, CasparCGSocketStatusEvent } from 'casparcg-connection'
import { ChannelSetup, config } from './config'

import { ServerResponse } from 'http'

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

const clientLimit = 4
const startExp = /(Content-type: image\/jpeg\r\nContent-length: (\d+)\r\n\r\n).*/

export class ImageProvider {
	casparcg: CasparCG

	mediaPath: string
	private _takenRegions: {[regionId: string]: true} = {}
	private _regionRoutes: {[routeId: string]: RegionRoute} = {}
	private _snapshots: {[channel: string]: Snapshot} = {}
	private _fileIterator: number = 0
	private channelSetup: ChannelSetup[] = []

	// Streams:
	private casparStreams: {[streamId: string]: CasparStream} = {}
	private latest: Buffer = Buffer.alloc(0)
	private building: Buffer = Buffer.alloc(0)
	private streamReceivers: Array<{ r: ServerResponse, drained: boolean }> = []
	private frameCounter = 0

	private wasDisconnected: boolean = false

	constructor () {
		console.log(`Connecting to CasparCG at ${config.casparHost}, port ${config.casparPort}...`)
		this.casparcg = new CasparCG(config.casparHost, config.casparPort)
		this.casparcg.on(CasparCGSocketStatusEvent.CONNECTED, () => {
			console.log('CasparCG connected!')
			if (this.wasDisconnected) {
				this.wasDisconnected = false
				this.reset()
			}
		})
		this.casparcg.on(CasparCGSocketStatusEvent.DISCONNECTED, () => {
			console.log('CasparCG disconnected!')
			this.wasDisconnected = true
		})
	}

	async init () {

		const casparConfig = await this.casparcg.infoConfig()

		this.mediaPath = casparConfig.response.data.paths.mediaPath
		if (!this.mediaPath) throw new Error('Unable to get media path from casparCG')

		console.log(`CasparCG media path: "${this.mediaPath}"`)
		// test accessibility:
		await fsAccess(this.mediaPath)

		if (config.channels) {
			this.channelSetup = config.channels
		} else {
			// Default: Use last channel in CasparCG:
			const lastCasparChannelNumber = casparConfig.response.data.channels.length

			if (lastCasparChannelNumber > 1) {
				console.log(`Using CasparCG channel ${lastCasparChannelNumber} for streaming content.`)
				const casparChannel = casparConfig.response.data.channels[lastCasparChannelNumber - 1]
				if (!casparChannel) throw new Error(`Internal error: casparChannel`)
				let size = { width: 0, height: 0 }
				if (casparChannel.videoMode.match(/^720/)) size = { width: 1280, height: 720 }
				else if (casparChannel.videoMode.match(/^1080/)) size = { width: 1920, height: 2080 }
				else if (casparChannel.videoMode.match(/^1556/)) size = { width: 2048, height: 1556 }

				this.channelSetup = [{
					channel: lastCasparChannelNumber,
					resolution: Math.max(2, Math.ceil(Math.sqrt((lastCasparChannelNumber - 1) * 4))), // estimate how many
					width: size.width,
					height: size.height
				}]

			} else {
				throw new Error('This application uses the last channel in CasparCG for streaming, please add another channel in the CasparCG-config.')
			}
		}

		// Reset casparCG channels on startup:
		await Promise.all(
			_.map(this.channelSetup, channel => {
				return this.casparcg.clear(channel.channel)
			})
		)
	}
	reset () {
		console.log('Resetting all streams')
		this._regionRoutes = {}
		this.casparStreams = {}
		// this.streamReceivers = {}

		// Perhaps also clear caspar-layer ${myStream.channel}-998 here?
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
	async initStream (channel: number, layer?: number): Promise<StreamInfo> {
		const route = await this.getRegionRoute(channel, layer)
		if (route) {
			const streamId = 'stream' + route.region.channel
			await this.setupStream(streamId)
		}

		return this.getStreamInfo()
	}
	getStreamInfo (): StreamInfo {
		const streamInfo: StreamInfo = {
			regions: [],
			streams: []
		}
		const streams: {[streamId: string]: StreamInfoStream} = {}

		_.each(this._regionRoutes, (route: RegionRoute) => {

			const streamId = 'stream' + route.region.channel
			const region: StreamInfoRegion = {
				channel: route.channel,
				layer: route.layer,

				streamId: streamId,

				x: route.region.x,
				y: route.region.y,
				width: route.region.width,
				height: route.region.height
			}
			streamInfo.regions.push(region)

			if (!streams[region.streamId]) {
				streams[region.streamId] = {
					id: region.streamId,

					url: `/stream/${region.streamId}`,

					channel: route.region.channel,
					layer: route.region.layer,
					width: route.region.originalWidth,
					height: route.region.originalHeight
				}
			}
		})
		streamInfo.streams = _.values(streams)
		return streamInfo
	}
	async setupStream (streamId: string) {
		// Setup the caspar stream if not set:
		const streamInfo = this.getStreamInfo()
		const myStream = _.find(streamInfo.streams, stream => stream.id === streamId)
		if (!myStream) return

		if (!this.casparStreams[streamId]) {
			console.log('Setting up new Caspar-stream')
			this.casparStreams[streamId] = {
				created: Date.now(),
				lastReceivedTime: 0
			}

			await this.casparcg.do(
				new AMCP.CustomCommand({
					channel: myStream.channel,
					command: (
						`ADD ${myStream.channel}-998 STREAM http://127.0.0.1:${config.port}/feed/${myStream.id} -f mpjpeg -multiple_requests 1`
					)
				})
			)
		}
		//
	}
	/** Send a stream of mjpegs to the client */
	async setupClientStream (streamId: string, ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>) {
		if (this.streamReceivers.length >= clientLimit) {
			ctx.status = 429
			ctx.body = 'Maximum number of streams exceeded.'
			return
		}

		await this.setupStream(streamId)

		let stream = { r: ctx.res, drained: true }
		this.streamReceivers.push(stream)
		ctx.res.on('drain', () => { stream.drained = true })
		console.log(`Streaming client connected. ${this.streamReceivers.length} streams now active.`)
		ctx.res.on('error', err => { console.error(`Error for stream at index ${this.streamReceivers.indexOf(stream)}: ${err.message}`) })
		ctx.res.on('close', () => {
			this.streamReceivers = this.streamReceivers.filter(s => s !== stream)
			console.log(`Client closed. ${this.streamReceivers.length} streams active.`)
		})
		ctx.type = 'multipart/x-mixed-replace; boundary=--jpgboundary'
		ctx.status = 200
		return new Promise(_resolve => {
			// A promise that never resolves
		})
	}
	/** Receive the stream of mjpegs from CasparCG */
	feedStream (streamId: string, ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>) {
		console.log(`Receiving stream ${streamId} started`)
		ctx.req.on('data', (d: Buffer) => {
			// console.log('feedStream data ' + streamId)
			// console.log(d.length, d.slice(0, 100).toString('utf8'))
			let match = startExp.exec(d.slice(0, 60).toString('utf8'))
			// console.log(match, d.slice(0, 60).toString('utf8'))
			if (d.length === 10 && d.toString('utf8') === '--ffmpeg\r\n') {
				return
			}
			if (match) {
				this.latest = this.building.length > 12 && this.building[0] === 0xff && this.building[1] === 0xd8 ? Buffer.from(this.building.slice(0, -12)) : this.latest
				this.frameCounter++
				Promise.all(
					this.streamReceivers.map(
						(s, index) => new Promise((resolve: (b: boolean) => void, _reject) => {
							// console.log('<<<', index, s.drained)
							if (!s.drained) {
								console.log(`Dropping stream ${index} frame ${this.frameCounter}`)
								return resolve(s.drained)
							}
							s.r.write('--jpgboundary\r\n')
							s.r.write('Content-type: image/jpeg\r\n')
							s.r.write(`Content-length: ${this.latest.length}\r\n\r\n`)
							s.drained = s.r.write(this.latest)
							// console.log('>>>', index, s.drained)
							resolve(s.drained)
						}).catch(err => { console.error(`Failed to send JPEG to stream ${index}: ${err.message}`) })
					)
				)

				if (+match[2] !== 11532) {
					this.building = d.slice(Buffer.byteLength(match[1], 'utf8'))
				} else {
					this.building = Buffer.alloc(0)
				}
			} else {
				// console.log('In here', building.slice(-30), d.slice(-30))
				this.building = Buffer.concat([this.building, d])
			}
		})
		ctx.req.on('close', () => {
			console.log(`Receiving stream ${streamId} ended`)
			this.latest = Buffer.alloc(0)
			this.building = Buffer.alloc(0)
			this.frameCounter = 0
		})
		ctx.body = `Received frame part ${this.frameCounter}`
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

		_.each(this.channelSetup, (channel: ChannelSetup) => {
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
export interface StreamInfo {
	regions: StreamInfoRegion[]
	streams: StreamInfoStream[]
}
/**  */
export interface StreamInfoRegion {
	channel: number
	layer?: number

	streamId: string

	x: number
	y: number
	width: number
	height: number
}
export interface StreamInfoStream {
	id: string

	url: string

	channel: number
	layer: number

	width: number
	height: number
}
export interface CasparStream {
	created: number
	lastReceivedTime: number
}
