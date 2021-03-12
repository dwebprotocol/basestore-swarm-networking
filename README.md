# basestore-swarm-networking
[![Build Status](https://travis-ci.com/dwebprotocol/basestore-swarm-networking.svg?branch=master)](https://travis-ci.com/dwebprotocol/basestore-swarm-networking)

A basestore networking module that uses [dswarm](https://github.com/dwebprotocol/dswarm) to discovery peers. This module powers the networking portion of the [dDrive daemon](https://github.com/dwebprotocol/ddrive-daemon).

Calls to `seed` or `unseed` will not be persisted across restarts, so you'll need to use a separate dDatabase that maps discovery keys to network configurations. The dDrive daemon uses [Level](https://github.com/level/level) for this.

Since basestore has an all-to-all replication model (any shared cores between two peers will be automatically replicated), only one connection needs to be maintained per peer. If multiple connections are opened to a single peer as a result of that peer announcing many keys, then these connections will be automatically deduplicated by comparing NOISE keypairs.

### Installation
```
npm i basestore-swarm-networking -g
```

### Usage
```js
const SwarmNetworker = require('basestore-swarm-networking')
const basestore = require('basestorex')
const ram = require('random-access-memory')

const store = new basestore(ram)
await store.ready()

const networker = new SwarmNetworker(store)

// Start announcing or lookup up a discovery key on the DHT.
await networker.join(discoveryKey, { announce: true, lookup: true })

// Stop announcing or looking up a discovery key.
networker.leave(discoveryKey)

// Shut down the swarm (and unnanounce all keys)
await networker.close()
```

### API

#### `const networker = new SwarmNetworker(basestore, networkingOptions = {})`
Creates a new SwarmNetworker that will open replication streams on the `basestore` instance argument.

`networkOpts` is an options map that can include all [dswarm](https://github.com/dwebprotocol/dswarm) options (which will be passed to the internal swarm instance) as well as:
```js
{
  id: crypto.randomBytes(32), // A randomly-generated peer ID,
  keyPair: ddatabaseProtocol.keyPair(), // A NOISE keypair that's used across all connections.
}
```

#### `await networker.join(discoveryKey, opts = {})`
Join the swarm with the `discoveryKey` argument as the topic.

If this is the first time a `join` or `leave` has been called, the swarm instance will be created automatically.

Waits for the topic to be fully joined before resolving.

`opts` is an options map of network configuration options that can include:
```js
  announce: true, // Announce the discovery key on the swarm
  lookup: true  // Look up the discovery key on the swarm
```

### `networker.joined(discoveryKey)`
Returns `true` if that discovery key is being swarmed.

### `networker.flushed(discoveryKey)`
Returns true if the swarm has discovered and attempted to connect to all peers announcing `discoveryKey`.

#### `await networker.leave(discoveryKey)`
Stop announcing or looking up the discovery key topic.

Waits for the key to be fully unannounced before resolving.

#### `await networker.close()`
Shut down the swarm networker.

This will close all replication streams and then destroy the swarm instance. It will wait for all topics to be unannounced, so it might take some time.

### License
MIT
