// F-12: gym-neutral favourites. PURE helpers (no db, no network).
//
// A favourite is a RECURRING SLOT: gym + studio + weekday + start time, in the
// class's own zone. It is deliberately the same shape as CodexFit's native
// bookmark key (`studioId + "0000" + dayOfWeek + "0000" + HHmm`, Sunday = 0), so
// the native path and the local path share one identifier and the client never
// branches on platform. A later rule (C5-2 Auto-Book Favourites) can add
// discipline/instructor columns without changing this key.
//
// Providers: Psycle stores these natively (capability `bookmarks`); every gym
// without native bookmarks uses the local `favourites` table (db.js). Nothing
// here knows which — see routes-normalized.js.

const { DateTime } = require('luxon');
const { resolveZone } = require('./providers/timezone');

const SEP = '0000';
const TAIL_LEN = SEP.length + 1 + SEP.length + 4; // 0000 d 0000 HHmm = 13
const LABEL_FIELDS = ['className', 'discipline', 'instructorName', 'studioName', 'locationName'];
const LABEL_MAX = 120;

/** Native-style identifier for a slot. Studio ids are STRINGS everywhere above the adapter. */
function toIdentifier({ studioId, dayOfWeek, startTime }) {
  return `${studioId}${SEP}${dayOfWeek}${SEP}${startTime}`;
}

/**
 * Inverse of toIdentifier. The tail is fixed width, so it is parsed from the END and
 * a studio id that itself contains "0000" still round-trips. null when malformed.
 */
function parseIdentifier(id) {
  if (typeof id !== 'string' || id.length <= TAIL_LEN) return null;
  const tail = id.slice(-TAIL_LEN);
  const studioId = id.slice(0, -TAIL_LEN);
  const m = /^0000([0-6])0000(\d{4})$/.exec(tail);
  if (!m || !studioId) return null;
  const hh = Number(m[2].slice(0, 2));
  const mm = Number(m[2].slice(2));
  if (hh > 23 || mm > 59) return null;
  return { studioId, dayOfWeek: Number(m[1]), startTime: m[2] };
}

/**
 * The slot a normalized event belongs to, read in the CLASS's zone (never the host's,
 * never a literal zone): the event's own published zone, else the gym's resolution.
 * @param {{studioId?:string|number, startAt?:string, timeZone?:string, locationId?:string|number}} event
 * @param {object} [gym] gyms.config entry, only consulted when the event carries no zone
 */
function slotOfEvent(event, gym) {
  if (!event || event.studioId == null || event.studioId === '' || !event.startAt) return null;
  const zone = resolveZone(gym, { providerZone: event.timeZone, locationId: event.locationId });
  const dt = DateTime.fromISO(String(event.startAt), { setZone: false }).setZone(zone);
  if (!dt.isValid) return null;
  return {
    studioId: String(event.studioId),
    dayOfWeek: dt.weekday % 7, // luxon: Mon=1..Sun=7 -> Sun=0
    startTime: dt.toFormat('HHmm'),
  };
}

/** Validate + normalise a request body into a slot (+ trimmed optional labels). */
function validateSlot(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'A favourite needs studioId, dayOfWeek and startTime.' };
  const studioId = body.studioId == null ? '' : String(body.studioId).trim();
  if (!studioId || studioId.length > 64) return { ok: false, error: 'studioId is required.' };
  const dow = typeof body.dayOfWeek === 'number' ? body.dayOfWeek : (/^\d$/.test(String(body.dayOfWeek)) ? Number(body.dayOfWeek) : NaN);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return { ok: false, error: 'dayOfWeek must be 0 (Sunday) to 6.' };
  const startTime = String(body.startTime == null ? '' : body.startTime);
  const hh = Number(startTime.slice(0, 2));
  const mm = Number(startTime.slice(2));
  if (!/^\d{4}$/.test(startTime) || hh > 23 || mm > 59) return { ok: false, error: 'startTime must be HHmm.' };
  const value = { studioId, dayOfWeek: dow, startTime };
  for (const f of LABEL_FIELDS) {
    if (body[f] != null && String(body[f]).trim()) value[f] = String(body[f]).trim().slice(0, LABEL_MAX);
  }
  return { ok: true, value };
}

/** Shape shared by the native and local paths (what GET /api/favourites returns). */
function makeFavourite(slot) {
  const out = {
    id: toIdentifier(slot),
    studioId: String(slot.studioId),
    dayOfWeek: Number(slot.dayOfWeek),
    startTime: slot.startTime,
  };
  for (const f of LABEL_FIELDS) if (slot[f]) out[f] = slot[f];
  return out;
}

module.exports = { toIdentifier, parseIdentifier, slotOfEvent, validateSlot, makeFavourite, LABEL_FIELDS };
