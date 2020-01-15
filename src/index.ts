import * as Koa from 'koa'
import * as Router from 'koa-router'
import * as bodyParser from 'koa-bodyparser'

import { ImageProvider } from './imageProvider'
import { config } from './config'

console.log('*******************************************')
console.log('CasparCG Image Provider')
console.log('*******************************************')
console.log('Initializing...')

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
		ctx.body = `Enpoints:
/channel/:channel/image
/layer/:channel/:layer/image`
	})
	router.get('/channel/:channel/view-image', async (ctx) => {
		// ctx.type = 'text/plain; charset=utf-8'
		ctx.body = `
	<html>
	<body>
	<img id="img">
	<script>

	  function arrayBufferToBase64(buffer) {
		var binary = ''
		var bytes = [].slice.call(new Uint8Array(buffer))

		bytes.forEach((b) => binary += String.fromCharCode(b))

		return window.btoa(binary)
	  }

	function updateImage () {
		fetch("/channel/${ctx.params.channel}/image?hash=" + Date.now())
		.then((response) => {
			response.arrayBuffer().then((buffer) => {
				var base64Flag = 'data:image/jpeg;base64,';
				var imageStr = arrayBufferToBase64(buffer);

				document.querySelector('img').src = base64Flag + imageStr;
				setTimeout(updateImage, 10)
			  });

			// document.getElementById('img').src =
		}, console.error)
	}
	// setInterval(updateImage, 100)
	updateImage()
	</script>
	</body>
	</html>`
	})
	router.get('/channel/:channel/view-stream', async (ctx) => {
		// ctx.type = 'text/plain; charset=utf-8'
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
	setupStream(document.getElementById("stream-container"), ${ctx.params.channel})
	</script>
	</body>
	</html>`
	})
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
	router.get('/channel/:channel/stream', async (ctx) => {
		// Set up internal routes of the channel and return info about the resulting stream
		try {
			const streamInfo = await imageProvider.initStream(ctx.params.channel)
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
			const streamInfo = await imageProvider.initStream(ctx.params.channel, ctx.params.layer)
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
			await imageProvider.setupClientStream(ctx.params.streamId, ctx)
		} catch (e) {
			console.log('Error yo')
			console.log(e.stack)
			throw e
		}
	})
	router.post('/feed/:streamId', async (ctx) => {
		// Receive a stream of mjpegs from CasparCG
		try {
			await imageProvider.feedStream(ctx.params.streamId, ctx)
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
