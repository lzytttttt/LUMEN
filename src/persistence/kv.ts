/**
 * kv.ts —— IndexedDB 薄封装（单库多 store），带内存兜底。
 *
 * 关键教训：idb-keyval 的 `createStore(db, name)` 只在**新建数据库**时创建该 store。
 * 先打开的 store 占住 v1，后打开的 store 在同一个库里根本不存在，`transaction` 直接抛
 * NotFoundError —— 表现为"重启后数据消失 + 静默切到内存模式"。
 * 因此这里自己开库：一次 upgrade 建齐全部 store，并把版本推到 2 以修复已损坏的 v1 库。
 */
export type StoreName = 'decks' | 'assets' | 'settings'

export type StorageMode = 'idb' | 'memory'

const DB_NAME = 'lumen-deck'
const DB_VERSION = 2
const STORE_NAMES: StoreName[] = ['decks', 'assets', 'settings']

let storageMode: StorageMode = 'idb'
let dbPromise: Promise<IDBDatabase> | null = null
const memory = new Map<StoreName, Map<string, unknown>>()

export function getStorageMode(): StorageMode {
  return storageMode
}

export function storageModeNotice(): boolean {
  return storageMode === 'memory'
}

function memStore(name: StoreName) {
  let s = memory.get(name)
  if (!s) {
    s = new Map()
    memory.set(name, s)
  }
  return s
}

function degrade(reason: unknown): void {
  if (storageMode !== 'memory') {
    storageMode = 'memory'
    console.warn('[storage] indexedDB 不可用，已切换到内存模式', reason)
  }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('indexedDB open blocked'))
  }).catch((error) => {
    dbPromise = null
    throw error
  })
  return dbPromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('idb request failed'))
  })
}

async function withStore<T>(
  name: StoreName,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb()
  const tx = db.transaction(name, mode)
  const store = tx.objectStore(name)
  const result = await fn(store)
  if (mode === 'readwrite') {
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('idb tx failed'))
      tx.onabort = () => reject(tx.error ?? new Error('idb tx aborted'))
    })
  }
  return result
}

export async function kvGet<T>(name: StoreName, key: string): Promise<T | undefined> {
  if (storageMode === 'idb') {
    try {
      return await withStore(name, 'readonly', (store) => requestToPromise(store.get(key)) as Promise<T>)
    } catch (err) {
      degrade(err)
    }
  }
  return memStore(name).get(key) as T | undefined
}

export async function kvSet(name: StoreName, key: string, value: unknown): Promise<boolean> {
  memStore(name).set(key, value)
  if (storageMode === 'idb') {
    try {
      await withStore(name, 'readwrite', (store) => requestToPromise(store.put(value, key)))
      return true
    } catch (err) {
      degrade(err)
      return false
    }
  }
  return false
}

export async function kvDel(name: StoreName, key: string): Promise<void> {
  memStore(name).delete(key)
  if (storageMode === 'idb') {
    try {
      await withStore(name, 'readwrite', (store) => requestToPromise(store.delete(key)))
    } catch (err) {
      degrade(err)
    }
  }
}

export async function kvKeys(name: StoreName): Promise<string[]> {
  if (storageMode === 'idb') {
    try {
      const keys = await withStore(name, 'readonly', (store) => requestToPromise(store.getAllKeys()))
      return keys.map(String)
    } catch (err) {
      degrade(err)
    }
  }
  return [...memStore(name).keys()]
}

export async function kvEntries<T>(name: StoreName): Promise<[string, T][]> {
  if (storageMode === 'idb') {
    try {
      const [keys, values] = await withStore(name, 'readonly', async (store) => {
        const allKeys = await requestToPromise(store.getAllKeys())
        const allValues = await requestToPromise(store.getAll())
        return [allKeys, allValues] as const
      })
      return keys.map((key, index) => [String(key), values[index] as T])
    } catch (err) {
      degrade(err)
    }
  }
  return [...memStore(name).entries()].map(([key, value]) => [key, value as T])
}
