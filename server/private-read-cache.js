// Completed normalized app responses, never raw credentials/provider bodies.
// One process; bounded memory. Flights stay in their caller's admission lane.
const changed = () => Object.assign(new Error('Data changed during read; retry'), { code: 'READ_CHANGED', status: 503 });
function createCache({ now = Date.now, maxEntries = 256, maxBytes = 8 * 1024 * 1024,
  maxEntryBytes = 256 * 1024, maxFlights = 32 } = {}) {
  const entries = new Map(), flights = new Map(), epochs = new Map(), writes = new Map();
  let bytes = 0;
  const epoch = gymId => epochs.get(gymId) || 0;
  function drop(key) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }
  function invalidateGym(gymId) {
    epochs.set(gymId, epoch(gymId) + 1);
    for (const [key, entry] of entries) if (entry.gymId === gymId) drop(key);
  }
  function beginMutation(gymId) {
    invalidateGym(gymId);
    writes.set(gymId, (writes.get(gymId) || 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const remaining = writes.get(gymId) - 1;
      if (remaining) writes.set(gymId, remaining); else writes.delete(gymId);
      invalidateGym(gymId);
    };
  }
  function check(gymId, version, validate) {
    const cacheable = validate() !== false;
    if (writes.has(gymId) || epoch(gymId) !== version) throw changed();
    return cacheable;
  }
  // Execution-local consumers share this cache's mutation generation and
  // active-write barrier instead of maintaining a second coherence ledger.
  function checkpoint(gymId) {
    const version = epoch(gymId);
    const assertCurrent = () => check(gymId, version, () => true);
    assertCurrent();
    return assertCurrent;
  }
  async function guard(gymId, validate, fetcher) {
    const version = epoch(gymId);
    check(gymId, version, validate);
    const value = await fetcher();
    check(gymId, version, validate);
    return value;
  }
  async function read(gymId, key, ttlMs, validate, fetcher) {
    const version = epoch(gymId), cacheable = check(gymId, version, validate);
    const entry = entries.get(key);
    if (entry && cacheable && entry.expires > now()) {
      entries.delete(key); entries.set(key, entry);
      require('./metrics').observeCache('hit');
      const value = structuredClone(entry.value);
      await Promise.resolve();
      check(gymId, version, validate);
      return value;
    }
    if (entry) drop(key);
    const flightKey = JSON.stringify([key, version, require('./provider-admission').actor().lane]);
    let pending = flights.get(flightKey);
    if (!pending) {
      if (flights.size >= maxFlights) throw Object.assign(new Error('Read capacity unavailable'), { code: 'READ_CAPACITY', status: 503 });
      require('./metrics').observeCache('miss');
      pending = (async () => {
        const value = await fetcher(), save = check(gymId, version, validate);
        const cloned = structuredClone(value);
        const size = Buffer.byteLength(JSON.stringify(cloned) ?? 'null');
        if (save && size <= maxEntryBytes && size <= maxBytes) {
          // Another admission lane may have completed this key meanwhile.
          drop(key);
          for (const [oldKey, old] of entries) if (old.expires <= now()) drop(oldKey);
          while (entries.size >= maxEntries || bytes + size > maxBytes) drop(entries.keys().next().value);
          entries.set(key, { gymId, value: cloned, bytes: size, expires: now() + ttlMs });
          bytes += size;
        }
        return cloned;
      })().finally(() => flights.delete(flightKey));
      flights.set(flightKey, pending);
    } else require('./metrics').observeCache('coalesced');
    const value = await pending;
    check(gymId, version, validate);
    return structuredClone(value);
  }
  return { read, guard, checkpoint, invalidateGym, beginMutation, stats: () => ({ entries: entries.size, bytes, inFlight: flights.size }) };
}
module.exports = { ...createCache(), createCache };
