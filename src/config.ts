import * as fs from 'fs'
import * as deepExtend from 'deep-extend'

const configFileName = './casparcg-image-provider.config.json'

let configContents: Buffer
let configParsed = {}
let found = true

try {
	configContents = fs.readFileSync(configFileName)
	configParsed = JSON.parse(configContents.toString())
} catch (error) {
	found = false
}

export interface IConfig {
	/** This server's port  */
	port: number

	/** CasparCG host */
	casparHost: string
	/** CasparCG port */
	casparPort?: number
	/** Which channels to use for snapshotting. If omitted, the image-provider will use the last CasparCG-channel. */

	channels?: ChannelSetup[]
	stream?: {
		/** Stream min quality (default: 2) */
		qmin?: number
		/** Stream max quality (default: 5) */
		qmax?: number
	}

	/** Which channels to put on the grid by default */
	streams?: StreamSetup[]
}
export interface ChannelSetup {
	/** CasparCG channel number (starting on 1) */
	channel: number
	/** What resolution to use. 1 = full resolution. 2 = will use the channel as a 2x2 grid, 3 = 3x3 etc. (Defaults to 3) */
	resolution: number

	width: number
	height: number
}

export interface StreamSetup {
	channel: number
	layer?: number
}

let defaultConfig: IConfig = {
	port: 5255,
	casparHost: '127.0.0.1',
	casparPort: 5250,

	stream: {
		qmin: 2,
		qmax: 5
	}

	// channels: [
	// 	{
	// 		channel: 3,
	// 		resolution: 2,
	// 		width: 1280,
	// 		height: 720
	// 	}
	// ]

	// streams: [
	// 	{
	// 		channel: 1,
	// 		layer: 2
	// 	}
	// ]
}

deepExtend(defaultConfig, configParsed)

export const config = defaultConfig
export const foundConfig = found
