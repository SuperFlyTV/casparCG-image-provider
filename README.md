# Casparcg Image Provider

Provides images from CasparCG channels & layers on a HTTP interface.
Sacrifices one of more channels in CasparCG for creating a grid, in order to provide several streams on one stream.

Using a channel for snapshotting

## Development
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

Reference implementations for client-side can be accessed at

* http://localhost:5255/channel/1/view-stream
* http://localhost:5255/channel/1/view-image
