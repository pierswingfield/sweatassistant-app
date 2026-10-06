// F-12: Settings > Favourites pane, pure model (no DOM, no network). The pane lists the account's favourites
// across every linked gym, grouped by weekday (Monday first), each resolved to the NEXT upcoming loaded class.
import { slotOfEvent, favouriteId } from '../favourites.js';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Monday first: CodexFit's Sun=0 maps to the end of the week.
const weekOrder = (d) => (Number(d) + 6) % 7;

/**
 * -> { groups: [{ dayOfWeek, label, items: [{ gymId, fav, event|null }] }], total, loadedGyms }.
 * `favouritesByGym[gymId]` is null/missing when that gym's list has not loaded: skipped, never read as "none".
 * `events` are the loaded Normalized events; a class counts only if it has not started yet at `now`.
 */
export function buildFavouriteGroups({ favouritesByGym = {}, gymIds = [], events = [], now = new Date() }) {
  // Earliest upcoming event per gym + recurring slot. The gym id is part of the key: studio ids collide across gyms.
  const nextBySlot = new Map();
  const nowMs = now.getTime();
  for (const e of events) {
    const t = Date.parse(e.startAt);
    if (!Number.isFinite(t) || t < nowMs) continue;
    const slot = slotOfEvent(e);
    if (!slot) continue;
    const key = `${e.gymId}|${favouriteId(slot)}`;
    const cur = nextBySlot.get(key);
    if (!cur || t < cur.t) nextBySlot.set(key, { t, e });
  }

  const loadedGyms = [];
  const byDay = new Map();
  let total = 0;
  gymIds.forEach((gymId, gymOrder) => {
    const idx = favouritesByGym[gymId];
    if (!idx) return;
    loadedGyms.push(gymId);
    for (const fav of idx.items) {
      const id = fav.id || favouriteId(fav);
      const hit = nextBySlot.get(`${gymId}|${id}`);
      const day = Number(fav.dayOfWeek);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push({ gymId, fav, event: hit ? hit.e : null, gymOrder });
      total += 1;
    }
  });

  const groups = [...byDay.entries()]
    .sort((a, b) => weekOrder(a[0]) - weekOrder(b[0]))
    .map(([dayOfWeek, items]) => ({
      dayOfWeek,
      label: WEEKDAYS[dayOfWeek] || String(dayOfWeek),
      items: items
        .sort((x, y) => String(x.fav.startTime).localeCompare(String(y.fav.startTime)) || x.gymOrder - y.gymOrder)
        .map(({ gymOrder, ...rest }) => rest),
    }));
  return { groups, total, loadedGyms };
}

/** 'loading' (nothing loaded yet), 'empty' (loaded, none), or 'list'. */
export function paneState({ gymIds = [], loadedGyms = [], total = 0 }) {
  if (total > 0) return 'list';
  if (gymIds.length && !loadedGyms.length) return 'loading';
  return 'empty';
}
