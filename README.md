# Casparcg Image Provider

Streams CasparCG content to web clients, using Motion-JPEG.
Sacrifices a channel in CasparCG to create a grid, in order to provide several (low-quality-) streams on a single stream to the client.

## Usage

Run from source or download an executable from [Releases](https://github.com/SuperFlyTV/casparCG-image-provider/releases).

On initial startup a config file (`casparcg-image-provider.config`) will be created.
By default, the LAST channel in CasparCG will be used to create a 3-by-3 grid, allowing up to 9 previews to be streamed to the client.
Custom configuration is possible, and described [here](https://github.com/SuperFlyTV/casparCG-image-provider/blob/master/src/config.ts).

After having started the application, head over to [http:localhost:5255](http:localhost:5255) to explore the API.


## For developers
### Prerequisites

* yarn global add nodemon ts-node
```
yarn
yarn watch-server
```

### Packaging

To pack into a single executable, run:

Windows: `yarn pkg-win32`

### Ref implementation

Reference implementation for client-side can be accessed at

* http://localhost:5255/channel/1/view-stream
