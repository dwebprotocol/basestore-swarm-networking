const crypto = require('crypto')
const { EventEmitter } = require('events')
const { promisify } = require('util')

const dwebxEncoding = require('dwebx-encoding')
const ddatabaseProtocol = require('@ddatabase/protocol')
const dswarm = require('dswarm')
const pump = require('pump')
const eos = require('end-of-stream')

const log = require('debug')('basestore:network')

const OUTER_STREAM = Symbol('basestore-outer-stream')

class SwarmNetworker extends EventEmitter {
  constructor (basestore, opts = {}) {
    super()
    this.basestore = basestore
    this.id = opts.id || crypto.randomBytes(32)
    this.opts = opts
    this.keyPair = opts.keyPair || ddatabaseProtocol.keyPair()

    this._replicationOpts = {
      id: this.id,
      encrypt: true,
      live: true,
      keyPair: this.keyPair
    }

    this.streams = []
    this._joined = new Set()
    this._flushed = new Set()

    this._streamsProcessing = 0
    this._streamsProcessed = 0

    // Set in listen
    this.swarm = null

    this.setMaxListeners(0)
  }

  _replicate (protocolStream) {
    // The initiator parameter here is ignored, since we're passing in a stream.
    this.basestore.replicate(false, {
      ...this._replicationOpts,
      stream: protocolStream
    })
  }

  listen () {
    const self = this
    if (this.swarm) return

    this.swarm = dswarm({
      ...this.opts,
      announceLocalNetwork: true,
      queue: { multiplex: true }
    })
    this.swarm.on('error', err => this.emit('error', err))
    this.swarm.on('connection', (socket, info) => {
      const isInitiator = !!info.client
      if (socket.remoteAddress === '::ffff:127.0.0.1' || socket.remoteAddress === '127.0.0.1') return null
      const peerInfo = info.peer
      const discoveryKey = peerInfo && peerInfo.topic
      var finishedHandshake = false
      var processed = false

      const protocolStream = new ddatabaseProtocol(isInitiator, { ...this._replicationOpts })
      protocolStream.on('handshake', () => {
        const deduped = info.deduplicate(protocolStream.publicKey, protocolStream.remotePublicKey)
        if (!deduped) onhandshake()
        if (!processed) {
          processed = true
          this._streamsProcessed++
          this.emit('stream-processed')
        }
      })
      protocolStream.on('close', () => {
        this.emit('stream-closed', protocolStream, info, finishedHandshake)
        if (!processed) {
          processed = true
          this._streamsProcessed++
          this.emit('stream-processed')
        }
      })

      pump(socket, protocolStream, socket, err => {
        if (err) this.emit('replication-error', err)
        const idx = this.streams.indexOf(protocolStream)
        if (idx === -1) return
        this.streams.splice(idx, 1)
      })

      this.emit('stream-opened', protocolStream, info)
      this._streamsProcessing++

      function onhandshake () {
        finishedHandshake = true
        self._replicate(protocolStream)
        self.streams.push(protocolStream)
        self.emit('handshake', protocolStream, info)
      }
    })
  }

  status (discoveryKey) {
    return this.swarm && this.swarm.status(discoveryKey)
  }

  async join (discoveryKey, opts = {}) {
    if (this.swarm && this.swarm.destroyed) return null
    if (!this.swarm) {
      this.listen()
      return this.join(discoveryKey, opts)
    }
    const self = this

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : dwebxEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey : dwebxEncoding.decode(discoveryKey)

    this._joined.add(keyString)
    this.emit('joined', keyBuf)
    this.swarm.join(keyBuf, {
      announce: opts.announce !== false,
      lookup: opts.lookup !== false,
    })
    if (opts.flush !== false) {
      await promisify(this.swarm.flush.bind(this.swarm))()
      if (!this._joined.has(keyString)) {
        return
      }
      const processingAfterFlush = this._streamsProcessing
      if (this._streamsProcessed >= processingAfterFlush) {
        this._flushed.add(keyString)
        this.emit('flushed', keyBuf)
      } else {
        // Wait until the stream processing has caught up.
        const processedListener =  () => {
          if (!this._joined.has(keyString)) {
            this.removeListener('stream-processed', processedListener)
            return
          }
          if (this._streamsProcessed >= processingAfterFlush) {
            this._flushed.add(keyString)
            this.emit('flushed', keyBuf)
            this.removeListener('stream-processed', processedListener)
          }
        }
        this.on('stream-processed', processedListener)
      }
    }
  }

  async leave (discoveryKey) {
    if (this.swarm && this.swarm.destroyed) return
    if (!this.swarm) {
      this.listen()
      return this.leave(discoveryKey)
    }

    const keyString = (typeof discoveryKey === 'string') ? discoveryKey : dwebxEncoding.encode(discoveryKey)
    const keyBuf = (discoveryKey instanceof Buffer) ? discoveryKey : dwebxEncoding.decode(discoveryKey)

    this._joined.delete(keyString)

    await new Promise((resolve, reject) => {
      this.swarm.leave(keyBuf, err => {
        if (err) return reject(err)
        return resolve()
      })
    })

    for (let stream of this.streams) {
      stream.close(keyBuf)
    }
  }

  joined (discoveryKey) {
    if (typeof discoveryKey !== 'string') discoveryKey = discoveryKey.toString('hex')
    return this._joined.has(discoveryKey)
  }

  flushed (discoveryKey) {
    if (typeof discoveryKey !== 'string') discoveryKey = discoveryKey.toString('hex')
    return this._flushed.has(discoveryKey)
  }

  async close () {
    if (!this.swarm) return null

    const leaving = [...this._joined].map(dkey => this.leave(dkey))
    await Promise.all(leaving)

    const closingStreams = this.streams.map(stream => {
      return new Promise(resolve => {
        stream.destroy()
        eos(stream, () => resolve())
      })
    })
    await Promise.all(closingStreams)

    return new Promise((resolve, reject) => {
      this.swarm.destroy(err => {
        if (err) return reject(err)
        this.swarm = null
        return resolve()
      })
    })
  }
}

module.exports = SwarmNetworker
