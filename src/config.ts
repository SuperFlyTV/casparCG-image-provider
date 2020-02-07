
export interface IConfig {
	/** This server's port  */
	port: number

	/** CasparCG host */
	casparHost: string
	/** CasparCG port */
	casparPort?: number
	/** Which channels to use for snapshotting */
	channels: ChannelSetup[]

	/** Name of the folder inside of the media folder to use  */
	mediaFolderName?: string

	/** How long an existing file is allowed to be used */
	snapshotTimeout: number

	/** How many files to store on disk */
	maxFileCount: number
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
	mediaFolderName: 'snaps',

	snapshotTimeout: 300,
	maxFileCount: 100,

	channels: [
		{
			channel: 3,
			resolution: 2,
			width: 1280,
			height: 720
		}
	]
}
