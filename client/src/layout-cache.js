// Studio floor-plan cache (one lookup per fact: timetable's booking modal, the
// spot-map editor and Settings all read floor plans through here).
//
// A studio's plan changes very rarely, so: paint from cache immediately, revalidate
// in the background when older than FRESH_MS, keep serving up to MAX_AGE_MS, and on
// revalidate failure KEEP the cached plan (never trip the offline banner for it).
// Keys carry gym AND studio: provider studio ids collide across gyms. Storage is
// injected so the policy is unit-testable; production wires it to the IndexedDB
// `api-responses` store (per-user prefix applied by cache.js).

export const FRESH_MS = 24 * 60 * 60 * 1000;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const layoutKey = (gymId, studioId) => `layout:${gymId || ''}:${studioId}`;

// Layout identity: availability (isAvailable) is per-class state, not geometry.
export function layoutHash(slots, objects) {
  const g = (slots || []).map(s => [s.id, s.x, s.y, s.label, s.type ?? s.kind ?? ''].join(','));
  const o = (objects || []).map(x => JSON.stringify(x));
  return g.join('|') + '#' + o.join('|');
}

function strip(slots) {
  return (slots || []).map(s => { const { isAvailable, ...rest } = s; return rest; });
}

export function createLayoutCache({ read, write, fetchLayout, now = () => Date.now(), onChange }) {
  const mem = new Map(); // key -> { slots, objects, hash, savedAt }
  const inFlight = new Map();

  const store = async (key, slots, objects) => {
    const entry = { slots: strip(slots), objects: objects || [], hash: layoutHash(slots, objects), savedAt: now() };
    const prev = mem.get(key);
    mem.set(key, entry);
    try { await write(key, entry); } catch (_) {}
    return { entry, changed: !!prev && prev.hash !== entry.hash };
  };

  async function revalidate(gymId, studioId) {
    const key = layoutKey(gymId, studioId);
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
      try {
        const fresh = await fetchLayout(studioId, gymId);
        if (!fresh) return null;
        // Empty = "no floor map": a real answer, but never overwrite a known plan with it.
        if (!(fresh.slots || []).length) return { slots: [], objects: fresh.objects || [], empty: true };
        const { entry, changed } = await store(key, fresh.slots, fresh.objects);
        if (changed && onChange) onChange({ gymId, studioId, layout: entry });
        return entry;
      } catch (_) {
        return null; // keep cached plan; flaky network is not an error here
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, p);
    return p;
  }

  /** Synchronous, memory-only read (what the booking modal's loading copy needs). */
  function peek(gymId, studioId) {
    const e = mem.get(layoutKey(gymId, studioId));
    return e ? { slots: e.slots, objects: e.objects } : null;
  }

  /** Seed from a layout learned elsewhere (e.g. an event payload). */
  async function remember(gymId, studioId, slots, objects) {
    if (!(slots || []).length) return;
    const key = layoutKey(gymId, studioId);
    const prev = mem.get(key);
    // Fuller layout wins, matching the booking modal's old defensive rule.
    if (prev && prev.slots.length > slots.length && prev.hash !== layoutHash(slots, objects)) return;
    await store(key, slots, objects);
  }

  /** Cache-first read: resolves from cache when usable, else from the network. */
  async function get(gymId, studioId) {
    const key = layoutKey(gymId, studioId);
    let entry = mem.get(key);
    if (!entry) {
      try { entry = await read(key); } catch (_) { entry = null; }
      if (entry && entry.slots) mem.set(key, entry); else entry = null;
    }
    if (entry && (now() - entry.savedAt) <= MAX_AGE_MS) {
      if ((now() - entry.savedAt) > FRESH_MS) revalidate(gymId, studioId);
      return { slots: entry.slots, objects: entry.objects, fromCache: true };
    }
    const fresh = await revalidate(gymId, studioId);
    if (fresh && !(fresh.empty && entry)) return { slots: fresh.slots, objects: fresh.objects, fromCache: false };
    if (entry) return { slots: entry.slots, objects: entry.objects, fromCache: true }; // expired but better than nothing
    throw new Error('Failed to load studio layout');
  }

  return { get, peek, remember, revalidate };
}
