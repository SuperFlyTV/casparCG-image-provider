import * as fs from 'fs'
import * as deepExtend from 'deep-extend'

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

	/** Which channels/layers to put on the grid by default */
	defaultRegions?: DefaultRegion[]
}
export interface ChannelSetup {
	/** CasparCG channel number (starting on 1) */
	channel: number
	/** What resolution to use. 1 = full resolution. 2 = will use the channel as a 2x2 grid, 3 = 3x3 etc. (Defaults to 3) */
	resolution: number

	width: number
	height: number
}

export type DefaultRegion = DefaultRegionRoute | DefaultRegionCustomContent
export interface DefaultRegionRoute {
	channel: number
	layer?: number
}
export function isDefaultRegionRoute (region: DefaultRegion): region is DefaultRegionRoute {
	return typeof (region as any).channel === 'number'
}
export interface DefaultRegionCustomContent {
	contentId: string
}
export function isDefaultRegionCustomContent (region: DefaultRegion): region is DefaultRegionCustomContent {
	return typeof (region as any).contentId === 'string'
}

const configFileName = './casparcg-image-provider.config.json'

export const config: IConfig = {
	// Default config:

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
/**
 * Reload config file, create one if it doesn't exist.
 * Return true if successful, false otherwise
 */
export function reloadConfig (): boolean {
	try {
		console.log(`Loading config file ${configFileName}`)
		const configContents: Buffer = fs.readFileSync(configFileName)
		const newConfig = JSON.parse(configContents.toString())
		deepExtend(config, newConfig)
		console.log('Loaded config:', JSON.stringify(config, null, 2))
		return true
	} catch (error) {
		if ((error + '').match(/ENOENT/)) { // file not found?
			// Try to create the file:
			console.log('Creating default config file')
			try {
				fs.writeFileSync(configFileName, JSON.stringify(config, null, 2), 'utf8')
				return true
			} catch (error) {
				console.log(`Error when creating config file: ${error}`)
				return false
			}
		} else {
			console.log(`Error when loading config file: ${error}`)
			return false
		}
	}
}
