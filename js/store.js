// Persistent, date-keyed cache of Open-Meteo responses (IndexedDB), plus a
// per-day estimate of API usage (localStorage).
//
// Every record carries the local date it was fetched on and is only used on
// that date, so each unique request is made at most once per day, across
// reloads and sessions. Records from earlier dates are pruned on startup.

const DB_NAME = 'zephyr-cache';
const DB_VERSION = 1;
const STORES = ['series', 'points'];
const USAGE_PREFIX = 'zephyr-usage-';

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let dbPromise = null;

// Resolves to null when IndexedDB is unavailable (private mode, blocked storage);
// callers then fall back to the in-memory cache only.
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      req.onupgradeneeded = () => {
        for (const name of STORES) {
          if (!req.result.objectStoreNames.contains(name)) {
            req.result.createObjectStore(name, { keyPath: 'key' }).createIndex('date', 'date');
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
  }
  return dbPromise;
}

function transaction(db, store, mode) {
  try {
    return db.transaction(store, mode);
  } catch {
    return null;
  }
}

/** Records for `keys` that exist in `store`, as a Map key -> record. */
export async function getMany(store, keys) {
  const out = new Map();
  const db = await openDb();
  const tx = db && keys.length ? transaction(db, store, 'readonly') : null;
  if (!tx) return out;
  return new Promise((resolve) => {
    const os = tx.objectStore(store);
    for (const key of keys) {
      const req = os.get(key);
      req.onsuccess = () => {
        if (req.result) out.set(key, req.result);
      };
    }
    tx.oncomplete = () => resolve(out);
    tx.onerror = tx.onabort = () => resolve(out);
  });
}

export async function putMany(store, records) {
  const db = await openDb();
  const tx = db && records.length ? transaction(db, store, 'readwrite') : null;
  if (!tx) return;
  return new Promise((resolve) => {
    const os = tx.objectStore(store);
    for (const r of records) os.put(r);
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
}

/** Deletes cached records and usage counters from earlier dates. */
export async function pruneOldDates() {
  const date = today();
  try {
    for (let k = localStorage.length - 1; k >= 0; k--) {
      const key = localStorage.key(k);
      if (key?.startsWith(USAGE_PREFIX) && key !== USAGE_PREFIX + date) localStorage.removeItem(key);
    }
  } catch {
    // storage blocked; nothing to prune
  }
  const db = await openDb();
  if (!db) return;
  for (const store of STORES) {
    const tx = transaction(db, store, 'readwrite');
    if (!tx) continue;
    await new Promise((resolve) => {
      const req = tx.objectStore(store).index('date').openKeyCursor(IDBKeyRange.upperBound(date, true));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        tx.objectStore(store).delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  }
}

export async function clearAll() {
  const db = await openDb();
  if (!db) return;
  for (const store of STORES) {
    const tx = transaction(db, store, 'readwrite');
    if (!tx) continue;
    await new Promise((resolve) => {
      tx.objectStore(store).clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    });
  }
}

// ---- Usage: estimated API calls today, and how much was served from cache ----

const listeners = [];

export function readUsage() {
  try {
    return { calls: 0, fetched: 0, cached: 0, ...JSON.parse(localStorage.getItem(USAGE_PREFIX + today())) };
  } catch {
    return { calls: 0, fetched: 0, cached: 0 };
  }
}

/** calls: estimated Open-Meteo calls spent; fetched / cached: series loaded from network / cache. */
export function addUsage({ calls = 0, fetched = 0, cached = 0 }) {
  const u = readUsage();
  u.calls += calls;
  u.fetched += fetched;
  u.cached += cached;
  try {
    localStorage.setItem(USAGE_PREFIX + today(), JSON.stringify(u));
  } catch {
    // counter is informational only
  }
  for (const fn of listeners) fn(u);
}

export function onUsage(fn) {
  listeners.push(fn);
}

// Open-Meteo counts each location as a call, and more than 10 variables or
// more than 14 days as proportionally more.
export function callWeight(locations, variables, days) {
  return locations * Math.max(1, variables / 10) * Math.max(1, days / 14);
}
