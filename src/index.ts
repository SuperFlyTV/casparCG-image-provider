import * as Koa from 'koa'
import * as Router from 'koa-router'
import * as bodyParser from 'koa-bodyparser'
import { ImageProvider } from './imageProvider'

const PORT = 3020

console.log('*******************************************')
console.log('CasparCG Image Provider')
console.log('*******************************************')

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
	router.get('/channel/:channel/view', async (ctx) => {
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
	router.get('/channel/:channel/image', async (ctx) => {

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
	router.get('/layer/:channel/:layer/image', async (ctx) => {
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
	app.use(router.routes())
	app.listen(PORT)
})
.then(() => {
	console.log(`Startup done, listening on http://localhost:${PORT}`)
})
.catch(console.error)
