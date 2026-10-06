// One-time migration of persisted client identifiers from the retired `psycle`
// prefix to `sweat` (naming audit step 5, phase A).
//
// Why a shim at all: renaming `psycleLocalToken` / `psycleUserId` / the onboarding
// flags / the theme without one logs every user out, re-runs onboarding and resets
// the theme. So the NEW key is read first, and only when it is absent is the OLD
// key copied across. The old key is deliberately LEFT IN PLACE for one release
// (rollback safety); it is removed by `removeStored()` on logout so a signed-out
// device never keeps a live token under the old name.
//
// Removal plan: once every active client has run a build containing this file,
// delete this module, the `import './storage-migrate.js'` side-effect lines (api.js,
// main.js), the `psycleTheme` fallback in index.html, and call
// `indexedDB.deleteDatabase('psycle-cache')`. Tracked in the naming audit, step 5.

export const MIGRATED_MARKER = 'sweatStorageMigrated';
export const IDB_MIGRATED_MARKER = 'sweatIdbMigrated';
export const LEGACY_DB_NAME = 'psycle-cache';

// Longest-first is not needed (no prefix is a prefix of another), but keep the
// table explicit: each entry is [legacyPrefix, newPrefix]. A key may carry a
// suffix (`psycleOnboardingStep:42`, `psycleUnifiedCacheMeta:42`), so matching is
// by prefix.
export const KEY_PREFIX_MAP = [
  ['psycleLocalToken', 'sweatLocalToken'],
  ['psycleUserId', 'sweatUserId'],
  ['psycleTheme', 'sweatTheme'],
  ['psycleDefaultFilters', 'sweatDefaultFilters'],
  ['psycleUnified', 'sweatUnified'],
  ['psycleCache', 'sweatCache'],
  ['psycleActiveStudioIds', 'sweatActiveStudioIds'],
  ['psycleOnboarding', 'sweatOnboarding'],
  ['psycleInstall', 'sweatInstall'],
  ['psycleHelperDismissed', 'sweatHelperDismissed'],
  ['psycleUpgradeExplainerDismissed', 'sweatUpgradeExplainerDismissed'],
];

/** Legacy key -> new key, or null when the key is not a legacy one. */
export function newKeyFor(legacyKey) {
  for (const [from, to] of KEY_PREFIX_MAP) {
    if (typeof legacyKey === 'string' && legacyKey.startsWith(from)) return to + legacyKey.slice(from.length);
  }
  return null;
}

/** New key -> its legacy twin, or null. */
export function legacyKeyFor(newKey) {
  for (const [from, to] of KEY_PREFIX_MAP) {
    if (typeof newKey === 'string' && newKey.startsWith(to)) return from + newKey.slice(to.length);
  }
  return null;
}

/**
 * Copy every legacy key that has no new-key twin. New-only and both leave the
 * new value untouched (new always wins). Idempotent; guarded by a marker so a
 * value the app deliberately removed (logout) is never resurrected from the
 * old copy on the next load.
 * Returns the number of keys copied.
 */
export function migrateLegacyStorage(storage) {
  let copied = 0;
  try {
    if (!storage || storage.getItem(MIGRATED_MARKER) === '1') return 0;
    const keys = [];
    for (let i = 0; i < storage.length; i++) keys.push(storage.key(i));
    for (const k of keys) {
      const next = newKeyFor(k);
      if (!next) continue;
      if (storage.getItem(next) !== null) continue;
      const v = storage.getItem(k);
      if (v === null) continue;
      storage.setItem(next, v);
      copied++;
    }
    storage.setItem(MIGRATED_MARKER, '1');
  } catch (_) { /* storage blocked: the app already tolerates that */ }
  return copied;
}

/** Remove a stored value under its new name AND its legacy twin (logout paths). */
export function removeStored(key, storage = globalThis.localStorage) {
  try {
    storage.removeItem(key);
    const legacy = legacyKeyFor(key);
    if (legacy) storage.removeItem(legacy);
  } catch (_) { /* storage blocked */ }
}

// --- IndexedDB -------------------------------------------------------------

function reqToPromise(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

/**
 * Copy every store of the legacy database into `newDb` (an open connection that
 * already has its stores), renaming keys with the same prefix map. The legacy
 * database is left in place. Resolves to the number of rows copied. Never throws:
 * every cache in it is refetchable, so failure just means a cold start.
 */
export async function copyLegacyDatabase(idb, newDb) {
  let copied = 0;
  try {
    if (!idb || typeof idb.databases !== 'function') return 0;
    const list = await idb.databases();
    if (!list.some((d) => d.name === LEGACY_DB_NAME)) return 0;
    const oldDb = await new Promise((resolve, reject) => {
      const req = idb.open(LEGACY_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (_) { /* nothing to create */ } };
    });
    try {
      for (const name of Array.from(oldDb.objectStoreNames)) {
        if (!newDb.objectStoreNames.contains(name)) continue;
        const rtx = oldDb.transaction(name, 'readonly');
        const store = rtx.objectStore(name);
        const [keys, values] = await Promise.all([reqToPromise(store.getAllKeys()), reqToPromise(store.getAll())]);
        if (!keys.length) continue;
        const wtx = newDb.transaction(name, 'readwrite');
        const dest = wtx.objectStore(name);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          const nk = typeof k === 'string' ? (newKeyFor(k) || k) : k;
          // add() not put(): a row the new database already holds wins.
          const r = dest.add(values[i], nk);
          r.onerror = (e) => { e.preventDefault(); };
          copied++;
        }
        await new Promise((resolve) => { wtx.oncomplete = resolve; wtx.onerror = resolve; wtx.onabort = resolve; });
      }
    } finally {
      oldDb.close();
    }
  } catch (_) { /* disposable caches: cold start is the fallback */ }
  return copied;
}

// Run the localStorage migration as an import side effect, so it has finished
// before any module that reads a key at load time (api.js reads the token at
// module scope). Import this file FIRST from api.js and main.js.
if (typeof localStorage !== 'undefined') migrateLegacyStorage(localStorage);
