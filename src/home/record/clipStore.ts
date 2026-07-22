/**
 * PANOPTICON // HOMEWATCH — local CLIP STORE (IndexedDB).
 *
 * Auto-captured clips live entirely in the browser's IndexedDB: metadata in
 * one object store, the video Blob in another (so listing never loads video
 * bytes into memory). Deletable any time; pruned oldest-first past a count /
 * byte budget. Nothing is ever uploaded. Every function is guarded — storage
 * being unavailable degrades to a no-op, never a crash.
 */
import type { ClipMeta } from '../types'

const DB_NAME = 'homewatch'
const DB_VERSION = 1
const META = 'clipMeta'
const BLOBS = 'clipBlobs'

/** retention budget — oldest clips are pruned beyond either limit */
export const MAX_CLIPS = 48
export const MAX_TOTAL_BYTES = 600 * 1024 * 1024

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** Promise wrapper around one IDB request. */
function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export async function addClip(meta: ClipMeta, blob: Blob): Promise<boolean> {
  try {
    const db = await openDb()
    if (!db) return false
    const tx = db.transaction([META, BLOBS], 'readwrite')
    tx.objectStore(META).put(meta)
    tx.objectStore(BLOBS).put({ id: meta.id, blob })
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    void prune()
    return true
  } catch {
    return false
  }
}

/** All clip metadata, newest first. */
export async function listClips(): Promise<ClipMeta[]> {
  try {
    const db = await openDb()
    if (!db) return []
    const all = await reqP(db.transaction(META).objectStore(META).getAll())
    return (all as ClipMeta[]).sort((a, b) => b.startedAt - a.startedAt)
  } catch {
    return []
  }
}

export async function getClipBlob(id: string): Promise<Blob | null> {
  try {
    const db = await openDb()
    if (!db) return null
    const rec = (await reqP(db.transaction(BLOBS).objectStore(BLOBS).get(id))) as { id: string; blob: Blob } | undefined
    return rec?.blob ?? null
  } catch {
    return null
  }
}

export async function deleteClip(id: string): Promise<void> {
  try {
    const db = await openDb()
    if (!db) return
    const tx = db.transaction([META, BLOBS], 'readwrite')
    tx.objectStore(META).delete(id)
    tx.objectStore(BLOBS).delete(id)
  } catch {
    /* ignore */
  }
}

/** Drop oldest clips beyond the count/byte budget. Best-effort. */
async function prune(): Promise<void> {
  try {
    const clips = await listClips() // newest first
    let total = 0
    const doomed: string[] = []
    clips.forEach((c, i) => {
      total += c.size
      if (i >= MAX_CLIPS || total > MAX_TOTAL_BYTES) doomed.push(c.id)
    })
    for (const id of doomed) await deleteClip(id)
  } catch {
    /* ignore */
  }
}
