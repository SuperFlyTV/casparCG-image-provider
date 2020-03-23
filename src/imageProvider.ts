import * as Koa from 'koa'
import * as _ from 'underscore'

import { AMCP, CasparCG, CasparCGSocketStatusEvent } from 'casparcg-connection'
import { ChannelSetup, config } from './config'

// import { ServerResponse } from 'http'

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

interface StreamReceiver {
	ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>
	drained: boolean
	singleImage?: boolean
	resolve: () => void
}
export class ImageProvider {
	casparcg: CasparCG

	private _takenRegions: {[contentId: string]: true} = {}
	private _regionContents: {[contentId: string]: RegionContent } = {}
	private channelSetup: ChannelSetup[] = []

	// Streams:
	private casparStreams: {[streamId: string]: CasparStream} = {}
	private latest: Buffer = Buffer.alloc(0)
	private building: Buffer = Buffer.alloc(0)
	private streamReceivers: Array<StreamReceiver> = []
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
				else if (casparChannel.videoMode.match(/^1080/)) size = { width: 1920, height: 1080 }
				else if (casparChannel.videoMode.match(/^1556/)) size = { width: 2048, height: 1556 }

				this.channelSetup = [{
					channel: lastCasparChannelNumber,
					resolution: 3,
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
		await this.initStreamsFromConfig()
	}
	reset () {
		console.log('Resetting all streams')
		this._regionContents = {}
		this._takenRegions = {}
		this.casparStreams = {}

		this.initStreamsFromConfig().catch(e => {
			console.log('Error')
			console.log(e.stack)
		})
		// Perhaps also clear caspar-layer ${myStream.channel}-998 here?
	}
	async initStreamsFromConfig () {
		if (config.streams) {
			await Promise.all(
				_.map(config.streams, stream => {
					return this.initStream(stream.channel, stream.layer)
				})
			)
		}
	}
	async initStream (id: string): Promise<StreamInfo>
	async initStream (channel: number, layer?: number): Promise<StreamInfo>
	async initStream (channelOrId: number | string, layer?: number): Promise<StreamInfo> {
		console.log('initStream', channelOrId, layer)
		let region: Region | undefined = undefined
		if (typeof channelOrId === 'string') {
			const contentId = channelOrId
			region = await this.createNewRegion(contentId)
		} else {
			const channel = channelOrId
			const route = await this.getRegionRoute(channel, layer)
			if (route) region = route.region
		}
		if (region) {
			const streamId = 'stream' + region.channel
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

		_.each(this._regionContents, (route: RegionContent) => {

			const streamId = 'stream' + route.region.channel
			const region: StreamInfoRegion = {
				contentId: isRegionCustomContent(route) ? route.contentId : this.getcontentId(route.channel, route.layer),
				channel: isRegionRoute(route) ? route.channel : undefined,
				layer: isRegionRoute(route) ? route.layer : undefined,

				region: {
					channel: route.region.channel,
					layer: route.region.layer
				},

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

			const qmin = config.stream && config.stream.qmin || 2
			const qmax = config.stream && config.stream.qmax || 5

			const streamProducerId = 998

			await this.casparcg.do(
				new AMCP.CustomCommand({
					channel: myStream.channel,
					command: (
						`REMOVE ${myStream.channel}-${streamProducerId}`
					)
				})
			)

			await this.casparcg.do(
				new AMCP.CustomCommand({
					channel: myStream.channel,
					command: (
						`ADD ${myStream.channel}-${streamProducerId} STREAM http://127.0.0.1:${config.port}/feed/${myStream.id} -f mpjpeg -multiple_requests 1 -qmin ${qmin} -qmax ${qmax}`
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

		return new Promise((resolve, reject) => {
			let stream = { ctx: ctx, drained: true, resolve }
			this.streamReceivers.push(stream)
			ctx.res.on('drain', () => { stream.drained = true })
			console.log(`Streaming client connected. ${this.streamReceivers.length} streams now active.`)
			ctx.res.on('error', err => {
				console.error(`Error for stream at index ${this.streamReceivers.indexOf(stream)}: ${err.message}`)
				this.streamReceivers = this.streamReceivers.filter(s => s !== stream)
				reject(err)
			})
			ctx.res.on('close', () => {
				this.streamReceivers = this.streamReceivers.filter(s => s !== stream)
				console.log(`Client closed. ${this.streamReceivers.length} streams active.`)
				resolve()
			})
			ctx.type = 'multipart/x-mixed-replace; boundary=--jpgboundary'
			ctx.status = 200
		})
	}
	/** Send an image from the stream of mjpegs to the client */
	async setupClientStreamAndReturnImage (streamId: string, ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>) {
		if (this.streamReceivers.length >= clientLimit) {
			ctx.status = 429
			ctx.body = 'Maximum number of streams exceeded.'
			return
		}

		await this.setupStream(streamId)

		return new Promise((resolve, reject) => {

			let stream = { ctx: ctx, drained: true, singleImage: true, resolve }
			this.streamReceivers.push(stream)
			ctx.res.on('drain', () => { stream.drained = true })
			console.log(`Image client connected. ${this.streamReceivers.length} streams now active.`)

			ctx.res.on('error', err => {
				console.error(`Error for stream at index ${this.streamReceivers.indexOf(stream)}: ${err.message}`)
				this.streamReceivers = this.streamReceivers.filter(s => s !== stream)
				reject(err)
			})
			ctx.res.on('close', () => {
				this.streamReceivers = this.streamReceivers.filter(s => s !== stream)
				resolve()
			})
			ctx.type = 'image/jpeg'
			ctx.status = 200
			// A promise that never resolves
		})
	}
	/** Receive the stream of mjpegs from CasparCG */
	feedStream (streamId: string, ctx: Koa.ParameterizedContext<Koa.DefaultState, Koa.DefaultContext>): void {
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
				this.latest = (
					this.building.length > 12 && this.building[0] === 0xff && this.building[1] === 0xd8 ?
					Buffer.from(this.building.slice(0, -12)) :
					this.latest
				)
				this.frameCounter++
				Promise.all(
					this.streamReceivers.map(
						(streamReceiver, index) => new Promise((resolve: (b: boolean) => void, _reject) => {
							// console.log('<<<', index, s.drained)
							if (!streamReceiver.drained) {
								console.log(`Dropping stream ${index} frame ${this.frameCounter}`)
								return resolve(streamReceiver.drained)
							}
							if (streamReceiver.singleImage) {
								// Write single image and tie it off
								streamReceiver.ctx.type = 'image/jpeg'
								streamReceiver.ctx.body = this.latest
								this.streamReceivers = this.streamReceivers.filter(s => s !== streamReceiver)
								if (streamReceiver.resolve) streamReceiver.resolve()
							} else {
								streamReceiver.ctx.res.write('--jpgboundary\r\n')
								streamReceiver.ctx.res.write('Content-type: image/jpeg\r\n')
								streamReceiver.ctx.res.write(`Content-length: ${this.latest.length}\r\n\r\n`)
								streamReceiver.drained = streamReceiver.ctx.res.write(this.latest)
								// console.log('>>>', index, s.drained)
							}
							resolve(streamReceiver.drained)
						}).catch(err => { console.error(`Failed to send JPEG to stream ${index}: ${err.message}`) })
					)
				).catch(console.error)

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
		const contentId = this.getcontentId(channel, layer)

		const route: RegionContent = this._regionContents[contentId]

		if (!route) {
			const newRoute: RegionRoute | undefined = await this.createNewRegionRoute(contentId, channel, layer)

			return newRoute
		} else {
			if (!isRegionRoute(route)) throw Error('Internal Error: Route "${contentId}" is not a RegionRoute')
			return route
		}
	}
	private async createNewRegion (contentId: string, channel?: number, layer?: number): Promise<Region | undefined> {
		console.log('Creating new region route', contentId, channel, layer)

		// find first free region
		let foundRegion: Region | undefined = _.find(this.getAvailableRegions(), (region: Region) => {
			return !this._takenRegions[region.id]
		})

		if (foundRegion) {
			this._takenRegions[foundRegion.id] = true

			if (channel) {
				const route: RegionRoute = {
					region: foundRegion,
					channel: channel,
					layer: layer
				}
				this._regionContents[contentId] = route
			} else {
				const content: RegionCustomContent = {
					region: foundRegion,
					contentId: contentId
				}
				this._regionContents[contentId] = content
			}

			await this.casparcg.mixerFill(
				foundRegion.channel,
				foundRegion.layer,
				foundRegion.x / foundRegion.originalWidth,
				foundRegion.y / foundRegion.originalHeight,
				foundRegion.width / foundRegion.originalWidth,
				foundRegion.height / foundRegion.originalHeight
			)
		}
		return foundRegion
	}
	private async createNewRegionRoute (contentId: string, channel: number, layer?: number): Promise<RegionRoute | undefined> {

		const foundRegion = await this.createNewRegion(contentId, channel, layer)
		if (foundRegion) {
			const regionContent = this._regionContents[contentId]

			if (isRegionRoute(regionContent)) {

				const route: RegionRoute = regionContent

				// Route the layer to the region:
				await this.casparCGRoute(
					foundRegion.channel,
					foundRegion.layer,
					route.channel,
					route.layer
				)
				return route
			}

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
	private getcontentId (channel: number, layer?: number) {
		if (layer) return `l_${channel}_${layer}`
		return `c_${channel}`
	}
	private async casparCGRoute (
		toChannel: number,
		toLayer: number,
		fromChannel: number,
		fromLayer?: number
	) {
		await this.casparcg.do(
			new AMCP.CustomCommand({
				channel: toChannel,
				command: (
					`PLAY ${toChannel}-${toLayer} route://${fromChannel + (fromLayer ? '-' + fromLayer : '')}`
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
type RegionContent = RegionRoute | RegionCustomContent
interface RegionRoute {
	region: Region
	channel: number
	layer?: number
}
function isRegionRoute (o: RegionContent): o is RegionRoute {
	return typeof (o as any).channel === 'number'
}
interface RegionCustomContent {
	region: Region
	contentId: string
}
function isRegionCustomContent (o: RegionContent): o is RegionCustomContent {
	return typeof (o as any).contentId === 'string'
}
export interface StreamInfo {
	regions: StreamInfoRegion[]
	streams: StreamInfoStream[]
}
/**  */
export interface StreamInfoRegion {
	contentId: string
	channel?: number
	layer?: number

	region: {
		channel: number
		layer: number
	}

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
