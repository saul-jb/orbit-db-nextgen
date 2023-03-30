import { strictEqual, deepStrictEqual } from 'assert'
import rmrf from 'rimraf'
import { copy } from 'fs-extra'
import * as IPFS from 'ipfs-core'
import { Log, Entry, Database, KeyStore, Identities } from '../src/index.js'
import config from './config.js'
import testKeysPath from './fixtures/test-keys-path.js'
import connectPeers from './utils/connect-nodes.js'
import waitFor from './utils/wait-for.js'
import ComposedStorage from '../src/storage/composed.js'
import IPFSBlockStorage from '../src/storage/ipfs-block.js'
import MemoryStorage from '../src/storage/memory.js'

const OpLog = { Log, Entry }
const keysPath = './testkeys'

describe('Database - Replication', function () {
  this.timeout(60000)

  let ipfs1, ipfs2
  let keystore
  let identities
  let testIdentity1, testIdentity2
  let db1, db2

  const databaseId = 'documentstore-AAA'

  const accessController = {
    canAppend: async (entry) => {
      const [identity1, identity2] = await Promise.all([
        identities.getIdentity(entry.identity),
        identities.getIdentity(entry.identity)
      ])

      return identity1.id === testIdentity1.id || identity2.id === testIdentity2.id
    }
  }

  beforeEach(async () => {
    await Promise.all([
      // Setup IPFS nodes
      Promise.resolve().then(async () => {
        [ipfs1, ipfs2] = await Promise.all([
          IPFS.create({ ...config.daemon1, repo: './ipfs1' }),
          IPFS.create({ ...config.daemon2, repo: './ipfs2' })
        ])

        await connectPeers(ipfs1, ipfs2)
      }),

      // Setup identities
      Promise.resolve().then(async () => {
        await copy(testKeysPath, keysPath)

        keystore = await KeyStore({ path: keysPath })
        identities = await Identities({ keystore })

        ;[testIdentity1, testIdentity2] = await Promise.all([
          identities.createIdentity({ id: 'userA' }),
          identities.createIdentity({ id: 'userB' })
        ])
      })
    ])
  })

  afterEach(async () => {
    await Promise.all([
      Promise.resolve().then(async () => {
        await db1?.drop()
        await db1?.close()
      }),
      Promise.resolve().then(async () => {
        await db2?.drop()
        await db2?.close()
      }),
      ipfs1?.stop(),
      ipfs2?.stop(),
      keystore.close()
    ])

    await Promise.all([
      rmrf(keysPath),
      rmrf('./ipfs1'),
      rmrf('./ipfs2'),
      rmrf('./orbitdb1'),
      rmrf('./orbitdb2')
    ])
  })

  describe('Replicate across peers', () => {
    beforeEach(async () => {
      [db1, db2] = await Promise.all([
        Database({ OpLog, ipfs: ipfs1, identity: testIdentity1, address: databaseId, accessController, directory: './orbitdb1' }),
        Database({ OpLog, ipfs: ipfs2, identity: testIdentity2, address: databaseId, accessController, directory: './orbitdb2' })
      ])
    })

    it('replicates databases across two peers', async () => {
      let replicated = false
      let expectedEntryHash = null

      const onConnected = (peerId, heads) => {
        replicated = expectedEntryHash !== null && heads.map(e => e.hash).includes(expectedEntryHash)
      }

      const onUpdate = (entry) => {
        replicated = expectedEntryHash !== null && entry.hash === expectedEntryHash
      }

      db2.events.on('join', onConnected)
      db2.events.on('update', onUpdate)

      await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })
      await db1.addOperation({ op: 'PUT', key: 2, value: 'record 2 on db 1' })
      await db1.addOperation({ op: 'PUT', key: 3, value: 'record 3 on db 1' })
      expectedEntryHash = await db1.addOperation({ op: 'PUT', key: 4, value: 'record 4 on db 1' })

      await waitFor(() => replicated, () => true)

      const all1 = []
      for await (const item of db1.log.iterator()) {
        all1.unshift(item)
      }

      const all2 = []
      for await (const item of db2.log.iterator()) {
        all2.unshift(item)
      }

      deepStrictEqual(all1, all2)
    })

    it('replicates databases across two peers with delays', async () => {
      let replicated = false
      let expectedEntryHash = null

      const onConnected = (peerId, heads) => {
        replicated = expectedEntryHash && heads.map(e => e.hash).includes(expectedEntryHash)
      }

      const onUpdate = (entry) => {
        replicated = expectedEntryHash && entry.hash === expectedEntryHash
      }

      db2.events.on('join', onConnected)
      db2.events.on('update', onUpdate)

      await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })

      await new Promise(resolve => {
        setTimeout(() => resolve(), 1000)
      })

      await db1.addOperation({ op: 'PUT', key: 2, value: 'record 2 on db 1' })
      await db1.addOperation({ op: 'PUT', key: 3, value: 'record 3 on db 1' })

      await new Promise(resolve => {
        setTimeout(() => resolve(), 1000)
      })

      expectedEntryHash = await db1.addOperation({ op: 'PUT', key: 4, value: 'record 4 on db 1' })

      await waitFor(() => replicated, () => true)

      const all1 = []
      for await (const item of db1.log.iterator()) {
        all1.unshift(item)
      }

      const all2 = []
      for await (const item of db2.log.iterator()) {
        all2.unshift(item)
      }

      deepStrictEqual(all1, all2)
    })

    it('adds an operation before db2 is instantiated', async () => {
      let connected = false

      const onConnected = (peerId, heads) => {
        connected = true
      }

      await Promise.all([
        db2.drop(),
        db2.close(),
        rmrf('./orbitdb2')
      ])

      await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })

      db2 = await Database({ OpLog, ipfs: ipfs2, identity: testIdentity2, address: databaseId, accessController, directory: './orbitdb2' })

      db2.events.on('join', onConnected)

      await waitFor(() => connected, () => true)

      const all1 = []
      for await (const item of db1.log.iterator()) {
        all1.unshift(item)
      }

      const all2 = []
      for await (const item of db2.log.iterator()) {
        all2.unshift(item)
      }

      deepStrictEqual(all1, all2)
    })
  })

  describe('Options', () => {
    it('uses given ComposedStorage with MemoryStorage/IPFSBlockStorage for entryStorage', async () => {
      const [storage1, storage2] = await Promise.all([
        ComposedStorage(
          ...(await Promise.all([
            MemoryStorage(),
            IPFSBlockStorage({ ipfs: ipfs1, pin: true })
          ]))
        ),
        ComposedStorage(
          ...(await Promise.all([
            MemoryStorage(),
            IPFSBlockStorage({ ipfs: ipfs2, pin: true })
          ]))
        )
      ])

      ;[db1, db2] = await Promise.all([
        Database({ OpLog, ipfs: ipfs1, identity: testIdentity1, address: databaseId, accessController, directory: './orbitdb1', entryStorage: storage1 }),
        Database({ OpLog, ipfs: ipfs2, identity: testIdentity2, address: databaseId, accessController, directory: './orbitdb2', entryStorage: storage2 })
      ])

      let connected1 = false
      let connected2 = false

      const onConnected1 = (peerId, heads) => {
        connected1 = true
      }

      const onConnected2 = (peerId, heads) => {
        connected2 = true
      }

      db1.events.on('join', onConnected1)
      db2.events.on('join', onConnected2)

      await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })
      await db1.addOperation({ op: 'PUT', key: 2, value: 'record 2 on db 1' })
      await db1.addOperation({ op: 'PUT', key: 3, value: 'record 3 on db 1' })
      await db1.addOperation({ op: 'PUT', key: 4, value: 'record 4 on db 1' })

      await Promise.all([
        waitFor(() => connected1, () => true),
        waitFor(() => connected2, () => true)
      ])


      const all1 = []
      const all2 = []

      await Promise.all([
        Promise.resolve(async () => {
          for await (const item of db1.log.iterator()) {
            all1.unshift(item)
          }
        }),

        Promise.resolve(async () => {
          for await (const item of db2.log.iterator()) {
            all2.unshift(item)
          }
        })
      ])

      deepStrictEqual(all1, all2)
    })
  })

  describe('Events', () => {
    beforeEach(async () => {
      [db1, db2] = await Promise.all([
        Database({ OpLog, ipfs: ipfs1, identity: testIdentity1, address: databaseId, accessController, directory: './orbitdb1' }),
        Database({ OpLog, ipfs: ipfs2, identity: testIdentity2, address: databaseId, accessController, directory: './orbitdb2' })
      ])
    })

    it('emits \'update\' once when one operation is added', async () => {
      const expected = 1
      let connected1 = false
      let connected2 = false
      let updateCount1 = 0
      let updateCount2 = 0

      const onConnected1 = (peerId, heads) => {
        connected1 = true
      }

      const onConnected2 = (peerId, heads) => {
        connected2 = true
      }

      const onUpdate1 = async (entry) => {
        ++updateCount1
      }

      const onUpdate2 = async (entry) => {
        ++updateCount2
      }

      db1.events.on('join', onConnected1)
      db2.events.on('join', onConnected2)
      db1.events.on('update', onUpdate1)
      db2.events.on('update', onUpdate2)

      await Promise.all([
        waitFor(() => connected1, () => true),
        waitFor(() => connected2, () => true)
      ])

      await db1.addOperation({ op: 'PUT', key: 1, value: 'record 1 on db 1' })

      await Promise.all([
        waitFor(() => updateCount1 >= expected, () => true),
        waitFor(() => updateCount2 >= expected, () => true)
      ])

      strictEqual(updateCount1, expected)
      strictEqual(updateCount2, expected)
    })

    it('emits \'update\' 4 times when 4 documents are added', async () => {
      const expected = 4
      let connected1 = false
      let connected2 = false
      let updateCount1 = 0
      let updateCount2 = 0

      const onConnected1 = async (peerId, heads) => {
        connected1 = true
      }

      const onConnected2 = async (peerId, heads) => {
        connected2 = true
      }

      const onUpdate1 = async (entry) => {
        ++updateCount1
      }

      const onUpdate2 = async (entry) => {
        ++updateCount2
      }

      db1.events.on('join', onConnected1)
      db2.events.on('join', onConnected2)
      db1.events.on('update', onUpdate1)
      db2.events.on('update', onUpdate2)

      await Promise.all([
        waitFor(() => connected1, () => true),
        waitFor(() => connected2, () => true)
      ])

      await db1.addOperation({ op: 'PUT', key: 1, value: '11' })
      await db1.addOperation({ op: 'PUT', key: 2, value: '22' })
      await db1.addOperation({ op: 'PUT', key: 3, value: '33' })
      await db1.addOperation({ op: 'PUT', key: 4, value: '44' })

      await Promise.all([
        waitFor(() => updateCount1 >= expected, () => true),
        waitFor(() => updateCount2 >= expected, () => true)
      ])

      strictEqual(updateCount1, expected)
      strictEqual(updateCount2, expected)
    })
  })
})
