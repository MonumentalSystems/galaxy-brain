/**
 * Client-side binary asset store backed by IndexedDB.
 *
 * Large binaries (3D models, big media) don't fit in localStorage, which the
 * rest of the app uses for node state. We keep the bytes here and store only a
 * lightweight `assetId` reference on the node's metadata. The viewer resolves
 * the id back to an object URL at open time.
 */

const DB_NAME = "galaxy-brain-assets"
const STORE = "assets"
const DB_VERSION = 1

export type StoredAsset = {
  id: string
  blob: Blob
  fileName: string
  mimeType: string
  size: number
  createdAt: string
}

export function isAssetStoreAvailable(): boolean {
  return typeof indexedDB !== "undefined"
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isAssetStoreAvailable()) {
      reject(new Error("IndexedDB is not available in this environment"))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = run(transaction.objectStore(STORE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
        transaction.oncomplete = () => db.close()
      }),
  )
}

/** Store a blob/File and return its generated asset id. */
export async function putAsset(
  file: Blob & { name?: string },
  meta?: { fileName?: string; mimeType?: string },
): Promise<string> {
  const id = `asset_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  const record: StoredAsset = {
    id,
    blob: file,
    fileName: meta?.fileName || file.name || id,
    mimeType: meta?.mimeType || file.type || "application/octet-stream",
    size: file.size,
    createdAt: new Date().toISOString(),
  }
  await tx("readwrite", (store) => store.put(record))
  return id
}

export async function getAsset(id: string): Promise<StoredAsset | null> {
  try {
    const result = await tx<StoredAsset | undefined>("readonly", (store) => store.get(id))
    return result ?? null
  } catch {
    return null
  }
}

/** Resolve an asset id to an object URL the viewer can load. Caller revokes it. */
export async function getAssetObjectURL(id: string): Promise<string | null> {
  const asset = await getAsset(id)
  if (!asset) return null
  return URL.createObjectURL(asset.blob)
}

export async function deleteAsset(id: string): Promise<void> {
  try {
    await tx("readwrite", (store) => store.delete(id))
  } catch {
    /* best-effort */
  }
}
