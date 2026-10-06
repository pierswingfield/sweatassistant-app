// U4-7: progressive multi-gym merge with a grace window.
//
// graceMs <= 0 means: paint on the FIRST gym to settle, merge the rest as they land (user decision 2026-10-05).
// Gyms answer at very different speeds. Waiting for the slowest one made the
// whole timetable as slow as the worst gym. Rule:
//   - every gym settles inside `graceMs` of load start  -> ONE flush, all together
//   - otherwise, at `graceMs` flush whatever has arrived (if anything has),
//     then flush again as each late gym lands
//   - if nothing has arrived at `graceMs`, flush on the first arrival
// A failed gym counts as settled with no events (same as the old Promise.all
// path that mapped a failure to []).
//
// Pure: timers are injectable so the policy is unit-testable without a clock.
// Gym ids are compared as strings (normalized ids are strings, raw are numbers).

const startOf = (e) => new Date(e.startAt || e.start_at).getTime();

export function sortEvents(events) {
  return events.sort((a, b) => startOf(a) - startOf(b));
}

export function createProgressiveMerge({
  gymIds,
  graceMs = 4000,
  onFlush,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
}) {
  const all = gymIds.map(String);
  const pending = new Set(all);
  const arrived = new Map(); // gymId -> events (failed gyms hold [])
  let graceOver = false;
  let flushedOnce = false;
  let dirty = false;
  let timer = null;
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  function flush() {
    const events = sortEvents([...arrived.values()].flat());
    const isFinal = pending.size === 0;
    flushedOnce = true;
    dirty = false;
    if (isFinal && !finished) finished = true;
    onFlush({ events, pending: [...pending], final: isFinal, arrivedGyms: [...arrived.keys()] });
    if (isFinal) { if (timer) clearTimer(timer); resolveDone(events); }
  }

  function settle(gymId, events) {
    const id = String(gymId);
    if (!pending.has(id)) return;
    pending.delete(id);
    arrived.set(id, events || []);
    dirty = true;
    if (pending.size === 0) return flush();       // everyone in: single flush
    if (graceOver || graceMs <= 0) flush();                       // late gym: merge in now
  }

  if (all.length === 0) {
    queueMicrotask(() => { onFlush({ events: [], pending: [], final: true, arrivedGyms: [] }); resolveDone([]); });
  } else if (graceMs > 0) {
    timer = setTimer(() => {
      timer = null;
      graceOver = true;
      if (!finished && arrived.size > 0 && dirty) flush();
    }, graceMs);
  }

  return {
    arrive: settle,
    fail: (gymId) => settle(gymId, []),
    pending: () => [...pending],
    hasFlushed: () => flushedOnce,
    done,
  };
}
