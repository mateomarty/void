// SPDX-License-Identifier: AGPL-3.0-or-later
// Storage adapters. The engine only needs string-keyed buckets with prefix scans.
// MemStore is used in tests and as a fallback when the browser refuses IndexedDB.

export class MemStore {
  constructor() {
    this.buckets = new Map();
    this.persistent = false;
  }
  bucket(name) {
    let b = this.buckets.get(name);
    if (!b) this.buckets.set(name, (b = new Map()));
    return b;
  }
  async get(name, key) {
    return this.bucket(name).get(key);
  }
  async put(name, key, value) {
    this.bucket(name).set(key, value);
  }
  async del(name, key) {
    this.bucket(name).delete(key);
  }
  // Returns [{ key, value }] for keys starting with prefix, in key order.
  async range(name, prefix = '', limit = Infinity, reverse = false) {
    const out = [];
    for (const [key, value] of this.bucket(name)) if (key.startsWith(prefix)) out.push({ key, value });
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (reverse) out.reverse();
    return out.length > limit ? out.slice(0, limit) : out;
  }
  // Returns [{ key, value }] for lo <= key <= hi, in key order.
  async between(name, lo, hi) {
    const out = [];
    for (const [key, value] of this.bucket(name)) if (key >= lo && key <= hi) out.push({ key, value });
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  async delRange(name, prefix) {
    const b = this.bucket(name);
    for (const key of [...b.keys()]) if (key.startsWith(prefix)) b.delete(key);
  }
  async clear() {
    this.buckets.clear();
  }
}

const BUCKETS = ['kv', 'contacts', 'spaces', 'events', 'blobs', 'courier'];

export class IdbStore {
  constructor(db) {
    this.db = db;
    this.persistent = true;
  }

  static open(name) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(name, 1);
      } catch (e) {
        return reject(e);
      }
      req.onupgradeneeded = () => {
        for (const b of BUCKETS) if (!req.result.objectStoreNames.contains(b)) req.result.createObjectStore(b);
      };
      req.onsuccess = () => resolve(new IdbStore(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('database blocked'));
    });
  }

  tx(name, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(name, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('transaction failed'));
      const r = fn(tx.objectStore(name));
      if (r) r.onsuccess = () => (result = r.result);
    });
  }
  get(name, key) {
    return this.tx(name, 'readonly', (s) => s.get(key));
  }
  put(name, key, value) {
    return this.tx(name, 'readwrite', (s) => void s.put(value, key));
  }
  del(name, key) {
    return this.tx(name, 'readwrite', (s) => void s.delete(key));
  }
  range(name, prefix = '', limit = Infinity, reverse = false) {
    return this.scan(name, IDBKeyRange.bound(prefix, prefix + '￿'), limit, reverse);
  }
  between(name, lo, hi) {
    return this.scan(name, IDBKeyRange.bound(lo, hi), Infinity, false);
  }
  scan(name, bound, limit, reverse) {
    return new Promise((resolve, reject) => {
      const out = [];
      const tx = this.db.transaction(name, 'readonly');
      const req = tx.objectStore(name).openCursor(bound, reverse ? 'prev' : 'next');
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return;
        out.push({ key: cur.key, value: cur.value });
        cur.continue();
      };
      tx.oncomplete = () => resolve(out);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  }
  delRange(name, prefix) {
    return this.tx(name, 'readwrite', (s) => void s.delete(IDBKeyRange.bound(prefix, prefix + '￿')));
  }
  async clear() {
    for (const b of BUCKETS) await this.tx(b, 'readwrite', (s) => void s.clear());
  }
}

// Closes and deletes an IndexedDB database. Resolves even when the browser refuses.
export function dropDatabase(store, name) {
  return new Promise((resolve) => {
    try {
      store.db.close();
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

// Opens IndexedDB when the browser allows it, otherwise keeps everything in memory.
export async function openStore(name) {
  if (typeof indexedDB === 'undefined') return new MemStore();
  try {
    const store = await IdbStore.open(name);
    await store.get('kv', 'probe');
    return store;
  } catch {
    return new MemStore();
  }
}
