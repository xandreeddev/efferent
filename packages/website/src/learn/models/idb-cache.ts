// A download cache in IndexedDB, for where the browser's Cache API is missing:
// a page served over plain http from an address other than localhost (a dev
// server on the LAN) is no secure context, and browsers leave `caches` out
// there, so every visit would download the model again. IndexedDB is
// there on any origin. The shape is the slice of the Cache API that
// Transformers.js asks of a custom cache: `match` and `put`, by URL.

const DB = "efferent-learn-model-files"
const STORE = "files"

interface Stored {
  readonly body: Blob
  readonly headers: ReadonlyArray<readonly [string, string]>
}

const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DB, 1)
  request.onupgradeneeded = () => { request.result.createObjectStore(STORE) }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error("IndexedDB did not open"))
})

const run = <T>(db: IDBDatabase, mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    const request = act(db.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"))
  })

/** Whether this context lacks the Cache API, and so needs this cache to keep downloads. */
export const needsIndexedDbCache = (): boolean => typeof caches === "undefined"

/** A cache of downloaded files, kept in IndexedDB across visits, keyed by URL. */
export const indexedDbCache = () => {
  let db: Promise<IDBDatabase> | undefined
  const database = () => (db ??= open())
  return {
    match: async (url: string): Promise<Response | undefined> => {
      const found = await run<Stored | undefined>(await database(), "readonly", (store) => store.get(url))
      if (found === undefined) return undefined
      const headers = new Headers()
      found.headers.forEach(([key, value]) => headers.append(key, value))
      headers.set("content-length", String(found.body.size))
      return new Response(found.body, { headers })
    },
    put: async (url: string, response: Response): Promise<void> => {
      const body = await response.blob()
      const stored: Stored = { body, headers: [...response.headers.entries()] }
      await run(await database(), "readwrite", (store) => store.put(stored, url))
    },
  }
}
