/**
 * IndexedDB storage. Takes stay in this browser until the speaker downloads
 * the ZIP; nothing is uploaded anywhere.
 *
 * Audio is stored as ArrayBuffer rather than Blob: older Safari versions
 * could not keep Blobs in IndexedDB reliably.
 */
const DB_NAME = 'hirenote-rekam';
const DB_VERSION = 1;
let dbPromise = null;

function db() {
    if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error('no-idb')); return; }
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const d = req.result;
                d.createObjectStore('takes');
                d.createObjectStore('kv');
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('no-idb'));
        });
    }
    return dbPromise;
}

function run(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('aborted'));
    }));
}

export const takeKey = (kode, id) => `${kode}/${id}`;

export const getKv = (k) => run('kv', 'readonly', (s) => s.get(k));
export const setKv = (k, v) => run('kv', 'readwrite', (s) => s.put(v, k));

export const getTake = (kode, id) => run('takes', 'readonly', (s) => s.get(takeKey(kode, id)));
export const putTake = (take) => run('takes', 'readwrite', (s) => s.put(take, takeKey(take.kode, take.id)));

/** All takes of one speaker code. */
export function takesOf(kode) {
    const range = IDBKeyRange.bound(`${kode}/`, `${kode}/￿`);
    return run('takes', 'readonly', (s) => s.getAll(range));
}

/** Light index (no audio) of one speaker's takes: id → take without `wav`. */
export async function indexOf(kode) {
    const all = await takesOf(kode);
    const map = new Map();
    for (const t of all) { const { wav, ...rest } = t; map.set(t.id, rest); }
    return map;
}

export async function clearAll() {
    await run('takes', 'readwrite', (s) => s.clear());
    await run('kv', 'readwrite', (s) => s.clear());
}
