import * as Koa from 'koa'
import * as Router from 'koa-router'
import * as bodyParser from 'koa-bodyparser'

import { ImageProvider } from './imageProvider'
import { config, foundConfig } from './config'
import * as _ from 'underscore'

console.log('*******************************************')
console.log('CasparCG Image Provider')
console.log('*******************************************')
console.log('Initializing...')
console.log(foundConfig ? 'Config file found.' : 'Config file not found.')

const app = new Koa()
const router = new Router()

const imageProvider = new ImageProvider()

imageProvider.init()
.then(() => {
	console.log('Starting up web server...')
	app.use(bodyParser({
		onerror: (err, ctx) => {
			ctx.status = 400
			ctx.body = {
				status: 400,
				message: err.message,
				 stack: '' }
		}
	}))
	router.get('/', async (ctx) => {
		ctx.body = `<html><body><h1>Endpoints:</h1>
<table>
<tbody>

<tr><td><a href="/info">/info</a></td><td>Info about all regouns and streams</td></tr>
<tr><td><a href="/channel/1/view-stream">/channel/:channel/view-stream</a></td><td>Reference client implementation</td></tr>

<tr><td><a href="/stream/stream2">/stream/:streamId</a></td><td>Receive a grid as a motion-jpeg stream</td></tr>
<tr><td><a href="/image/stream2">/image/:streamId</a></td><td>Receice a grid as a jpeg image</td></tr>

<tr><td><a href="/channel/1/stream">/channel/:channel/stream</a></td><td>Route a channel to a grid-stream</td></tr>
<tr><td><a href="/channel/1/10/stream">/channel/:channel/:layer/stream</a></td><td>Route a layer to a grid-stream</td></tr>
<tr><td><a href="custom/customName">custom/:regionId</a></td><td>Reserve a spot in a grid, to be populated with content later</td></tr>

<!--
<h3>Deprecated:</h3>
<ul>
<tr><td><a href="/channel/:channel/view-image">/channel/:channel/view-image</a></td><td></td></tr>
<tr><td><a href="/channel/:channel/image">/channel/:channel/image</a></td><td></td></tr>
<tr><td><a href="/channel/:channel/:layer/image">/channel/:channel/:layer/image</a></td><td></td></tr>
-->
</tbody>
</table>
</body></html>
`
	})
	router.get('/channel/:channel/view-stream', async (ctx) => {
		const channel: number | undefined = ctx.params.channel === undefined ? undefined : Number(ctx.params.channel)
		if (channel === undefined) { ctx.body = 'parameter :channel not provided'; return }

		ctx.body = `
	<html>
	<body>
	<img id="img">

	<div id="stream-container"></div>
	<script>

	function setupStream (element, channel) {
		const urlBase = ""

		// First, let it be known of our intentions:
		fetch(urlBase + "/channel/" + channel + "/stream")
		.then(response => response.json())
		.then(streamInfo => {
			// The server has now set up the stream and given us a link to it.
			// We must now crop and display the video stream.

			// Find the region:
			const region = streamInfo.regions.find(r => r.channel == channel)
			if (!region) throw new Error("Region for channel " + channel + " not found")


			// Find the stream that the region uses:
			const stream = streamInfo.streams.find(s => s.id == region.streamId)
			if (!region) throw new Error("Stream " + region.streamId + " not found")

			const w = stream.width / region.width
			const y = region.y / region.height
			const x = region.x / region.width

			const img = new Image();
			img.addEventListener("load", function (e) { console.log("load", e) })
			img.addEventListener("error", function (e) { console.log("error", e) })

			img.style.position = "absolute"
			img.style.width = (w * 100) + "%"
			img.style.top = (-y * 100) + "%"
			img.style.left = (-x * 100) + "%"
			img.style.background = "#000000"
			img.src = urlBase + stream.url

			const div = document.createElement("div")
			div.style.width = "100%"
			div.style.paddingTop = "56.25%"
			div.style.position = "relative"
			div.style.overflow = "hidden"

			div.appendChild(img)
			element.appendChild(div)

		})
	}
	setupStream(document.getElementById("stream-container"), ${channel})
	</script>
	</body>
	</html>`
	})
	/*
	router.get('/channel/:channel/image', async (ctx) => {
		// Set up internal routes and return a png image for that channell
		try {
			const stream = await imageProvider.getImage(ctx.params.channel)

			if (stream) {
				ctx.type = 'image/png'
				ctx.body = ctx.req.pipe(stream)
			} else {
				ctx.type = 'text/plain; charset=utf-8'
				ctx.body = 'Unable to return channel image'
			}
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.get('/channel/:channel/:layer/image', async (ctx) => {
		// Set up internal routes and return a png image for that layer
		try {
			const stream = await imageProvider.getImage(ctx.params.channel, ctx.params.layer)

			if (stream) {
				ctx.type = 'image/png'
				ctx.body = ctx.req.pipe(stream)
			} else {
				ctx.type = 'text/plain; charset=utf-8'
				ctx.body = 'Unable to return layer image'
			}
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	*/
	router.get('/channel/:channel/stream', async (ctx) => {
		// Set up internal routes of the channel and return info about the resulting stream
		try {
			const channel: number | undefined = ctx.params.channel === undefined ? undefined : Number(ctx.params.channel)
			if (channel === undefined) { ctx.body = 'parameter :channel not provided'; return }
			if (isNaN(Number(channel))) { ctx.body = 'parameter :channel must be a number'; return }

			const streamInfo = await imageProvider.initStream(channel)
			ctx.type = 'application/json; charset=utf-8'
			ctx.body = JSON.stringify(streamInfo)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.get('/channel/:channel/:layer/stream', async (ctx) => {
		// Set up internal routes of the layer and return info about the resulting stream
		try {
			const channel: number | undefined = ctx.params.channel === undefined ? undefined : Number(ctx.params.channel)
			if (channel === undefined) { ctx.body = 'parameter :channel not provided'; return }
			if (isNaN(Number(channel))) { ctx.body = 'parameter :channel must be a number'; return }

			const layer: number | undefined = ctx.params.layer === undefined ? undefined : Number(ctx.params.layer)
			if (layer === undefined) { ctx.body = 'parameter :layer not provided'; return }
			if (isNaN(Number(layer))) { ctx.body = 'parameter :layer must be a number'; return }

			const streamInfo = await imageProvider.initStream(channel, layer)
			ctx.type = 'application/json; charset=utf-8'
			ctx.body = JSON.stringify(streamInfo)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.get('/custom/:regionId', async (ctx) => {
		// Instead of setting up routes, just use a layer in the grid and let the external system add content to it later
		try {
			const regionId: string | undefined = ctx.params.regionId === undefined ? undefined : ctx.params.regionId
			if (!regionId) { ctx.body = 'parameter :regionId not provided'; return }

			const streamInfo = await imageProvider.initStream(regionId)
			ctx.type = 'application/json; charset=utf-8'
			ctx.body = JSON.stringify(streamInfo)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.get('/stream/:streamId', async (ctx) => {
		// Return the stream to the client
		try {
			const streamId: string | undefined = ctx.params.streamId === undefined ? undefined : ctx.params.streamId
			if (!streamId) {
				ctx.body = 'parameter :streamId not provided';
				return
			}

			await imageProvider.setupClientStream(streamId, ctx)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.get('/image/:streamId', async (ctx) => {
		// Return the an image to the client
		try {
			const streamId: string | undefined = ctx.params.streamId === undefined ? undefined : ctx.params.streamId
			if (!streamId) {
				ctx.body = 'parameter :streamId not provided';
				return
			}

			await imageProvider.setupClientStreamAndReturnImage(streamId, ctx)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.post('/feed/:streamId', async (ctx) => {
		// Receive a stream of mjpegs from CasparCG
		try {
			const streamId: string | undefined = ctx.params.streamId === undefined ? undefined : ctx.params.streamId
			if (!streamId) {
				ctx.body = 'parameter :streamId not provided';
				return
			}

			imageProvider.feedStream(streamId, ctx)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.get('/info', async (ctx) => {
		// Info about streams
		try {
			const streamInfo = imageProvider.getStreamInfo()
			ctx.type = 'application/json; charset=utf-8'
			ctx.body = JSON.stringify(streamInfo)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	app.use(router.routes())
	app.listen(config.port)
})
.then(() => {
	console.log(`Initialization done, listening on http://localhost:${config.port}`)
	console.log('*******************************************')
})
.catch(console.error)
