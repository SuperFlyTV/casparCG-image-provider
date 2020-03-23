
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
}
export interface ChannelSetup {
	/** CasparCG channel number (starting on 1) */
	channel: number
	/** What resolution to use. 1 = full resolution. 2 = will use the channel as a 2x2 grid, 3 = 3x3 etc */
	resolution: number

	width: number
	height: number
}

export const config: IConfig = {
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
}
