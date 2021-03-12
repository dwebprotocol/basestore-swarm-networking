const test = require('tape')
const ram = require('random-access-memory')
const dht = require('@dswarm/dht')
const ddatabaseCrypto = require('@ddatabase/crypto')
const ddatabaseProtocol = require('@ddatabase/protocol')
const basestore = require('basestorex')

const SwarmNetworker = require('..')

const BOOTSTRAP_PORT = 3100
var bootstrap = null

test('simple replication', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const base1 = store1.get()
  const base2 = store2.get(base1.key)

  await networker1.join(base1.discoveryKey)
  await networker2.join(base2.discoveryKey)

  await append(base1, 'hello')
  const dwebxa = await get(base2, 0)
  t.same(dwebxa, Buffer.from('hello'))

  await cleanup([networker1, networker2])
  t.end()
})

test('replicate multiple top-level bases', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const base1 = store1.get()
  const base2 = store1.get()
  const base3 = store2.get(base1.key)
  const base4 = store2.get(base2.key)

  await networker1.join(base1.discoveryKey)
  await networker1.join(base2.discoveryKey)
  await networker2.join(base2.discoveryKey)
  await networker2.join(base3.discoveryKey)

  await append(base1, 'hello')
  await append(base2, 'world')
  const d1 = await get(base3, 0)
  const d2 = await get(base4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  await cleanup([networker1, networker2])
  t.end()
})

test('replicate to multiple receivers', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()
  const { store: store3, networker: networker3 } = await create()

  const base1 = store1.get()
  const base2 = store2.get(base1.key)
  const base3 = store3.get(base1.key)

  await networker1.join(base1.discoveryKey)
  await networker2.join(base2.discoveryKey)
  await networker3.join(base3.discoveryKey)

  await append(base1, 'hello')
  const d1 = await get(base2, 0)
  const d2 = await get(base3, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('hello'))

  await cleanup([networker1, networker2, networker3])
  t.end()
})

test('replicate sub-bases', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()

  const base1 = store1.get()
  const base3 = store2.get(base1.key)

  await networker1.join(base1.discoveryKey)
  await networker2.join(base3.discoveryKey)

  const base2 = store1.get({ parents: [base1.key] })
  const base4 = store2.get({ key: base2.key, parents: [base3.key]})

  await append(base1, 'hello')
  await append(base2, 'world')
  const d1 = await get(base3, 0)
  const d2 = await get(base4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  await cleanup([networker1, networker2])
  t.end()
})

test('can replication with a custom keypair', async t => {
  const keyPair1 = ddatabaseProtocol.keyPair()
  const keyPair2 = ddatabaseProtocol.keyPair()
  const { store: store1, networker: networker1 } = await create({ keyPair: keyPair1 })
  const { store: store2, networker: networker2 } = await create({ keyPair: keyPair2 })

  const base1 = store1.get()
  const base3 = store2.get(base1.key)

  await networker1.join(base1.discoveryKey)
  await networker2.join(base3.discoveryKey)

  const base2 = store1.get()
  const base4 = store2.get({ key: base2.key })

  await append(base1, 'hello')
  await append(base2, 'world')
  const d1 = await get(base3, 0)
  const d2 = await get(base4, 0)
  t.same(d1, Buffer.from('hello'))
  t.same(d2, Buffer.from('world'))

  t.same(networker1.streams[0].remotePublicKey, keyPair2.publicKey)
  t.same(networker1.streams[0].publicKey, keyPair1.publicKey)
  t.same(networker2.streams[0].remotePublicKey, keyPair1.publicKey)
  t.same(networker2.streams[0].publicKey, keyPair2.publicKey)

  await cleanup([networker1, networker2])
  t.end()
})

test('join status only emits flushed after all handshakes', async t => {
  const { store: store1, networker: networker1 } = await create()
  const { store: store2, networker: networker2 } = await create()
  const { store: store3, networker: networker3 } = await create()

  const base1 = store1.get()
  const base2 = store2.get(base1.key)
  await append(base1, 'hello')

  let join2Flushed = 0
  let join3Flushed = 0
  let join2FlushPeers = 0
  let join3FlushPeers = 0

  // If ifAvail were not blocked, the get would immediately return with null (unless the connection's established immediately).
  await networker1.join(base1.discoveryKey)
  networker2.on('flushed', dkey => {
    if (!dkey.equals(base1.discoveryKey)) return
    join2Flushed++
    join2FlushPeers = base2.peers.length
  })
  await networker2.join(base1.discoveryKey)

  const base3 = store3.get(base1.key)
  networker3.on('flushed', (dkey) => {
    if (!dkey.equals(base1.discoveryKey)) return
    join3Flushed++
    join3FlushPeers = base3.peers.length
    allFlushed()
  })
  networker3.join(base1.discoveryKey)

  async function allFlushed () {
    t.same(join2Flushed, 1)
    t.true(join2FlushPeers >= 1)
    t.same(join3Flushed, 1)
    t.true(join3FlushPeers >= 2)
    await cleanup([networker1, networker2, networker3])
    t.end()
  }
})

test('can destroy multiple times', async t => {
  const { networker } = await create()

  await networker.close()
  await networker.close()
  t.pass('closed successfully')

  await cleanup([networker])
  t.end()
})

test.skip('each basestore only opens one connection per peer', async t => {
  t.end()
})

async function create (opts = {}) {
  if (!bootstrap) {
    bootstrap = dht({
      bootstrap: false
    })
    bootstrap.listen(BOOTSTRAP_PORT)
    await new Promise(resolve => {
      return bootstrap.once('listening', resolve)
    })
  }
  const store =  new basestore(ram)
  await store.ready()
  const networker = new SwarmNetworker(store,  { ...opts, bootstrap: `localhost:${BOOTSTRAP_PORT}` })
  return { store, networker }
}

function append (base, dwebxa) {
  return new Promise((resolve, reject) => {
    base.append(dwebxa, err => {
      if (err) return reject(err)
      return resolve()
    })
  })
}

function get (base, idx, opts = {}) {
  return new Promise((resolve, reject) => {
    base.get(idx, opts, (err, dwebxa) => {
      if (err) return reject(err)
      return resolve(dwebxa)
    })
  })
}

async function cleanup (networkers) {
  for (let networker of networkers) {
    await networker.close()
  }
  if (bootstrap) {
    await bootstrap.destroy()
    bootstrap = null
  }
}
