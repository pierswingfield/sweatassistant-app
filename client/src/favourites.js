// F-12: gym-neutral favourites, pure client helpers (no DOM, no network).
//
// A favourite is a recurring slot: studio + weekday + start time, read in the CLASS's own
// zone (zoneFor), never the device's. The key is the same string CodexFit uses for its
// native bookmarks, so one id works for every gym. A list is per GYM (provider studio ids
// collide across gyms), so callers always hold one index per gym id and ask the row's own
// gym — see cache.favouritesByGym / favouritesForGym in main.js.
import { DateTime } from 'luxon';
import { zoneFor } from './lib.js';

/** The recurring slot an event belongs to, or null if it lacks a studio or start time. */
export function slotOfEvent(event) {
  if (!event || event.studioId == null || event.studioId === '' || !event.startAt) return null;
  const dt = DateTime.fromISO(String(event.startAt)).setZone(zoneFor(event));
  if (!dt.isValid) return null;
  return {
    studioId: String(event.studioId),
    dayOfWeek: dt.weekday % 7, // luxon Mon=1..Sun=7 -> Sun=0, as CodexFit's key
    startTime: dt.toFormat('HHmm'),
  };
}

/** `studioId + "0000" + dayOfWeek + "0000" + HHmm`, e.g. studio 138, Monday 19:30 -> "1380000100001930". */
export function favouriteId(slot) {
  return slot ? `${slot.studioId}0000${slot.dayOfWeek}0000${slot.startTime}` : '';
}

/** Display-only labels stored beside a favourite (never used for matching). */
export function labelsOfEvent(event) {
  const out = {};
  if (event.name) out.className = event.name;
  if (event.discipline) out.discipline = event.discipline;
  const inst = event.instructors && event.instructors[0] && event.instructors[0].name;
  if (inst) out.instructorName = inst;
  if (event.studioName) out.studioName = event.studioName;
  if (event.locationName) out.locationName = event.locationName;
  return out;
}

/** Server list -> { items, ids }. */
export function indexFavourites(list) {
  const items = Array.isArray(list) ? list : [];
  return { items, ids: new Set(items.map((f) => f.id || favouriteId(f))) };
}

/** Is this event a favourite in `index` (ONE gym's index)? null/undefined (not loaded) -> false. */
export function isFavouriteIn(index, event) {
  if (!index || !index.ids) return false;
  const slot = slotOfEvent(event);
  return !!slot && index.ids.has(favouriteId(slot));
}
