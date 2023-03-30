// Compose storages:
// const storage1 = await ComposedStorage(await LRUStorage(), await LevelStorage())
// const storage2 = await ComposedStorage(storage1, await IPFSBlockStorage())

const ComposedStorage = async (storage1, storage2) => {
  const put = async (hash, data) => {
    await Promise.all([
      storage1.put(hash, data),
      storage2.put(hash, data)
    ])
  }

  const get = async (hash) => {
    let value = await storage1.get(hash)
    if (!value) {
      value = await storage2.get(hash)
      if (value) {
        await storage1.put(hash, value)
      }
    }
    return value
  }

  const iterator = async function * () {
    const keys = []
    for (const storage of [storage1, storage2]) {
      for await (const [key, value] of storage.iterator()) {
        if (!keys[key]) {
          keys[key] = true
          yield [key, value]
        }
      }
    }
  }

  const merge = async (other) => {
    await Promise.all([
      storage1.merge(other),
      storage2.merge(other),
      other.merge(storage1),
      other.merge(storage2)
    ])
  }

  const clear = async () => {
    await Promise.all([
      storage1.clear(),
      storage2.clear()
    ])
  }

  const close = async () => {
    await Promise.all([
      storage1.close(),
      storage2.close()
    ])
  }

  return {
    put,
    get,
    iterator,
    merge,
    clear,
    close
  }
}

export default ComposedStorage
