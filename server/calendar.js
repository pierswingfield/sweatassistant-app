// user-specific calendar feed (iCalendar / .ics).
//
// Publishes one VEVENT per class (booked, plus optionally tentative auto-book /
// waitlist) to a per-user, token-authenticated `.ics` URL that Apple/Google
// Calendar subscribe to. See Documentation/CALENDAR_FEED_PLAN.md for the design.
//
// The feed endpoint serves a pre-built snapshot (calendar_snapshots). Snapshots
// are regenerated (a) every 3 hours by a single all-user poll that also refreshes
// bookings + waitlists from CodexFit, and (b) immediately after any in-app or
// background action that changes a user's classes (auto-book/upgrade success,
// booking sync, cancellation).

const crypto = require('crypto');
const cron = require('node-cron');
const { DateTime } = require('luxon');
const db = require('./db');
const { getGymConfig } = require('./gyms.config');
const { zoneOfGym, resolveZone } = require('./providers/timezone');
const poller = require('./poller');
const { triggerAutoRelogin } = require('./auth');
const { getProvider } = require('./providers');
const gymOutbound = require('./gym-outbound');
const { cleanClassName: cleanClassNameShared, disciplineHead } = require('./class-name');
const { policyOf, isRollingWeekly, mostRecentRelease } = require('./providers/booking-window');
const { normalizeCalendarPrefs } = require('./calendar-prefs');
const bookingSync = require('./booking-sync');

// Interim single-gym bridge, same as scheduler.js/poller.js (WP-D3 will replace).
// No module-level provider (WP-D7) — resolved per user, since a calendar feed is
// per-gym (its token lives on user_gyms).

const { appName, publicHost: APP_HOST, calendarUidNamespace: UID_NAMESPACE } = require('./config');
const PAST_CLASS_CAP = 100;            // rolling history kept per user
const LOCATIONS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MIN = 45;
const PENALTY_HOURS = 12;              // free-cancellation deadline before class start
const WINDOW_REMINDER_MIN = 15;        // the ONLY alarm a booking-window event carries
const WINDOW_EVENT_COUNT = 4;          // how many upcoming release instants are published
const WINDOW_EVENT_DURATION_MIN = 15;

// ─── Token + subscribe links ─────────────────────────────────────────────────
/**
 * Every gym this account is linked to.
 *
 * The feed is ACCOUNT-level (2026-09-14): a person has one calendar and expects
 * every class in it, not one .ics per gym each showing a third of their week.
 * Everything below that used to call db.resolveActiveGymId() now runs once per
 * gym in this list — via db.runWithGymContext, so the ~20 per-user db accessors
 * stay unchanged and simply resolve to whichever gym the current pass is on.
 */
function linkedGymIds(userId) {
  try { return (db.getUserGyms(userId) || []).filter((g) => g.account_enabled && g.status === 'active').map((g) => g.gym_id).filter(Boolean); }
  catch (_) { return []; }
}

function generateToken() { return crypto.randomBytes(24).toString('base64url'); }

function ensureToken(userId) {
  let t = db.getCalendarToken(userId);
  if (!t) { t = generateToken(); db.setCalendarToken(userId, t); }
  return t;
}
function rotateToken(userId) { const t = generateToken(); db.setCalendarToken(userId, t); return t; }

function buildLinks(token) {
  const httpsUrl = `https://${APP_HOST}/api/calendar/${token}.ics`;
  const httpUrl = `http://${APP_HOST}/api/calendar/${token}.ics`;
  return {
    https: httpsUrl,
    webcal: `webcal://${APP_HOST}/api/calendar/${token}.ics`,
    // Apple subscribe buttons use plain webcal://, the only scheme iOS/macOS register. Apple may
    // warn "The connection is not secure" because it resolves webcal:// to http:// first (C4-8).
    // webcals:// avoids the warning but Safari on iOS rejects it as an invalid address, so
    // it is kept only for clients that are known to register it; the https URL (copy
    // button) works everywhere.
    webcals: `webcals://${APP_HOST}/api/calendar/${token}.ics`,
    // Google's cid subscribe only accepts the http:// form of the feed URL (the https
    // and addbyurl variants are rejected with "Check the URL"). Passed unencoded —
    // the token is URL-safe base64 so no escaping is needed.
    google: `https://calendar.google.com/calendar/u/0/r?cid=${httpUrl}`,
  };
}

// ─── Location → address cache (server_kv, very long TTL, ONE ENTRY PER GYM) ────
// C3-20: this was a single global `locations_json` entry. Gym A's refresh stamped
// it, so gym B's refresh early-returned on the TTL and B's addresses never
// reached the feed. Location names are gym-local too, so the entries must not be
// merged into one map. A leftover global `locations_json` from the old build is
// ignored (it cannot be attributed to a gym) and simply ages out unused.
const locationsKey = (gymId) => `locations_json:${gymId}`;

function cachedLocationMap(gymId) {
  if (!gymId) return {};
  const raw = db.getKV(locationsKey(gymId));
  if (raw) { try { return JSON.parse(raw).map || {}; } catch (_) {} }
  return {};
}

async function refreshLocationMap(userId, force = false, gymId = null) {
  const gym = gymId || db.resolveActiveGymId(userId);
  const raw = db.getKV(locationsKey(gym));
  if (!force && raw) {
    try { if (Date.now() - JSON.parse(raw).ts < LOCATIONS_TTL_MS) return; } catch (_) {}
  }
  try {
    const res = await poller.fetchFromGym(userId, gym, '/locations');
    if (!res.ok) return;
    const payload = await res.json();
    const list = payload.data || payload || [];
    const map = {};
    for (const loc of (Array.isArray(list) ? list : [])) {
      if (loc.name) map[loc.name] = loc.address || '';
    }
    db.setKV(locationsKey(gym), JSON.stringify({ ts: Date.now(), map }));
  } catch (_) { /* keep whatever is cached */ }
}

// ─── Bookings + waitlists ────────────────────────────────────────────────────
// T-B: the feed no longer fetches. server/booking-sync.js is the one background
// writer of booking_cache + waitlist_cache (same enrichment: start, names,
// duration, address, normalized slot label) and calls afterBookingSync() below
// once a calendar user's gyms are refreshed, so the feed is built from exactly
// the rows that sync stored, with no second fetch and no overwrite.

// Attempt a normalized list call with the same 401-triggers-relogin ladder the
// old inline fetchCodexFit() gave every authenticated call (WP-N3), mirroring
// scheduler.js's/poller.js's bookSlotWithRelogin. codexfit.listBookings/
// listWaitlists throw with `.status` set on HTTP failure (see codexfit.js doc
// comment) instead of returning a result object — that's the signal here too.
async function listWithRelogin(userId, method, explicitGymId) {
  const gymId = explicitGymId || db.resolveActiveGymId(userId);
  // The SESSION must be read inside this gym's context. `db.getUserById`
  // resolves the user's ACTIVE gym's session, so during a fan-out every gym
  // after the active one was handed the wrong gym's token — the JAB pass
  // authenticated to MarianaTek with a CodexFit JWT and got a 401 on every
  // call. The fan-out looked like it was working (it logged both gyms); only
  // the feed contents showed it was not.
  const user = db.runWithGymContext(userId, gymId, () => db.getUserById(userId));
  if (!user || !user.jwt) throw new Error(`No active session for gym ${gymId}. Please log in.`);
  let session = { accessToken: user.jwt };
  try {
    return await getProvider(gymId)[method](session);
  } catch (err) {
    if (err.status !== 401) throw err;
    console.log(`[Calendar] ${method} got 401 for user ${userId} (${gymId}) — attempting relogin and retry.`);
    const newJwt = await triggerAutoRelogin(userId, gymId);
    session = { accessToken: newJwt };
    return require('./gym-connection').retrySessionCall(userId, gymId, newJwt, () => getProvider(gymId)[method](session));
  }
}

// booking_cache-shaped rows for one gym, via the sync module's builder (kept as
// calendar exports for the WP-N3 adapter-routing suite). null on failure.
async function fetchUserBookings(userId, gymId) {
  try {
    return await bookingSync.bookingRowsFor(userId, gymId || db.resolveActiveGymId(userId));
  } catch (err) {
    console.error(`[Calendar] fetchUserBookings failed for user ${userId}:`, err.message);
    return null;
  }
}

// waitlist_cache-shaped rows for one gym (throws on failure).
async function fetchUserWaitlists(userId, gymId) {
  return bookingSync.waitlistRowsFor(userId, gymId || db.resolveActiveGymId(userId));
}

// ─── Gather a user's live classes (precedence: confirmed > waitlist > autobook) ─
function gatherLiveClasses(userId, gymId) {
  // Keyed by gym AND event id. Event ids are PROVIDER ids, unique only inside
  // one gym, so an event-id-only key silently dropped one gym's class whenever
  // two gyms happened to publish the same id — which the mocks do today
  // (Psycle 1000-1279, JAB 9000-9139) and two real providers eventually will.
  const byEvent = new Map();
  const key = (eventId) => `${gymId}:${eventId}`;

  // Auto-book pending (lowest precedence)
  for (const ab of db.getUserAutoBookings(userId)) {
    if (ab.status !== 'pending' || !ab.start_at || ab.event_id == null) continue;
    byEvent.set(key(ab.event_id), {
      gymId, eventId: ab.event_id, startAt: ab.start_at, className: ab.class_name,
      groupName: ab.group_name, instructorName: ab.instructor_name,
      studioName: ab.studio_name, locationName: ab.location_name,
      status: 'autobook', slotLabel: null, durationMin: null,
    });
  }

  // Waitlists (override autobook)
  for (const w of db.getWaitlistCacheForUser(userId)) {
    if (!w.start_at || w.event_id == null) continue;
    byEvent.set(key(w.event_id), {
      gymId, eventId: w.event_id, startAt: w.start_at, className: w.class_name,
      groupName: w.group_name, instructorName: w.instructor_name,
      studioName: w.studio_name, locationName: w.location_name, locationAddress: w.location_address,
      status: 'waitlist', slotLabel: null, durationMin: null,
    });
  }

  // Confirmed bookings (highest) — one VEVENT per event, join all booked spots
  const confirmed = new Map();
  for (const b of db.getBookingCacheForUser(userId)) {
    if (!b.start_at || b.event_id == null) continue;
    const k = key(b.event_id);
    if (!confirmed.has(k)) {
      confirmed.set(k, {
        gymId, eventId: b.event_id, startAt: b.start_at, className: b.class_name,
        groupName: b.group_name, instructorName: b.instructor_name,
        studioName: b.studio_name, locationName: b.location_name, locationAddress: b.location_address,
        status: 'confirmed', slots: [], durationMin: b.duration_min || null,
      });
    }
    const rec = confirmed.get(k);
    if (b.slot_label != null && String(b.slot_label).trim() !== '') rec.slots.push(String(b.slot_label).trim());
    if (!rec.durationMin && b.duration_min) rec.durationMin = b.duration_min;
    if (!rec.locationAddress && b.location_address) rec.locationAddress = b.location_address;
  }
  for (const [k, rec] of confirmed) {
    rec.slotLabel = rec.slots.join(', ');
    delete rec.slots;
    byEvent.set(k, rec);
  }

  return [...byEvent.values()];
}

// ─── Build a stored calendar_class record from a live class ───────────────────
function seatWordFor(groupName) { return /ride/i.test(groupName || '') ? 'bike' : 'spot'; }

function buildRecord(live, upgradeMap, existingByEvent) {
  const existing = existingByEvent[String(live.eventId)];
  // Original seat = the first slot we ever saw confirmed for this event.
  const originalSlotLabel = (existing && existing.original_slot_label) || live.slotLabel || null;

  // Upgrade annotation (confirmed classes only).
  let upgradeNote = null;
  if (live.status === 'confirmed') {
    const up = upgradeMap[String(live.eventId)];
    if (up) {
      const word = seatWordFor(live.groupName);
      const current = live.slotLabel;
      const changed = originalSlotLabel && current && originalSlotLabel !== current;
      if (changed) upgradeNote = `Auto-Upgrade is enabled -- originally ${word} ${originalSlotLabel}`;
      else if (up.status === 'active') upgradeNote = 'Auto-Upgrade is enabled';
    }
  }

  const durationMin = live.durationMin || null;
  const contentHash = crypto.createHash('md5').update(JSON.stringify([
    live.status, live.slotLabel, upgradeNote, live.startAt, durationMin,
    live.className, live.groupName, live.instructorName, live.studioName, live.locationName, live.locationAddress,
  ])).digest('hex');

  return {
    eventId: live.eventId, startAt: live.startAt, durationMin,
    className: live.className, groupName: live.groupName, instructorName: live.instructorName,
    studioName: live.studioName, locationName: live.locationName, locationAddress: live.locationAddress || null,
    slotLabel: live.slotLabel || null, status: live.status,
    upgradeNote, originalSlotLabel, contentHash,
  };
}

// ─── ICS serialization ────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function fmtLocal(dt) { return `${dt.year}${pad(dt.month)}${pad(dt.day)}T${pad(dt.hour)}${pad(dt.minute)}${pad(dt.second)}`; }
function fmtUTC(dt) { const u = dt.toUTC(); return `${u.year}${pad(u.month)}${pad(u.day)}T${pad(u.hour)}${pad(u.minute)}${pad(u.second)}Z`; }
function esc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n'); }
function titleCase(s) { return String(s || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase()); }

// Fold a content line to 75 octets per RFC 5545 (continuation lines start with a space).
function fold(line) {
  const out = [];
  let l = line;
  while (Buffer.byteLength(l, 'utf8') > 75) {
    let cut = 75;
    while (Buffer.byteLength(l.slice(0, cut), 'utf8') > 75) cut--;
    out.push(l.slice(0, cut));
    l = ' ' + l.slice(cut);
  }
  out.push(l);
  return out.join('\r\n');
}

// DTSTART/DTEND property for a zone. The feed ships ONE VTIMEZONE (Europe/London,
// kept byte-stable so existing subscribers see no churn); any other zone is
// emitted as an absolute UTC instant, which every client renders in the viewer's
// own zone without needing a VTIMEZONE for it.
function dtProp(name, dt) {
  return dt.zoneName === 'Europe/London'
    ? `${name};TZID=Europe/London:${fmtLocal(dt)}`
    : `${name}:${fmtUTC(dt)}`;
}

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/London',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0000',
  'TZOFFSETTO:+0100',
  'TZNAME:BST',
  'DTSTART:19700329T010000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0000',
  'TZNAME:GMT',
  'DTSTART:19701025T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// C3-29: some classes have no instructor (JAB Recovery), and a gym may publish a
// generic label instead of a name. Neither is a person, so neither belongs in
// the title. Returns the first name, or '' when there is no real one.
const PLACEHOLDER_INSTRUCTOR = /^(instructor|tba|tbc|tbd)$/i;
function instructorFirstName(name) {
  const full = String(name || '').trim();
  if (!full || PLACEHOLDER_INSTRUCTOR.test(full)) return '';
  return full.split(/\s+/)[0];
}

function buildTitle(row) {
  const discipline = titleCase(disciplineHead(row.group_name)) || 'Class';
  const instructor = instructorFirstName(row.instructor_name);
  // The prefix is the row's OWN gym, read from gyms.config. It used to be the
  // literal "Psycle", which was invisible while the feed was single-gym and
  // wrong the moment it was not: a JAB class appeared in the calendar as
  // "Psycle: Boxing with George", which is the one thing the title exists to
  // disambiguate now that one feed carries several gyms.
  const gym = row.gym_id ? getGymConfig(row.gym_id) : null;
  const gymName = (gym && (gym.shortName || gym.name)) || 'Class';
  // Strip the gym's own name off the front of the location so the title doesn't
  // read "Psycle: Ride with Sinead, Psycle Oxford Circus".
  const location = stripGymPrefix(row.location_name || '', gym);
  const core = `${gymName}: ${discipline}${instructor ? ` with ${instructor}` : ''}${location ? `, ${location}` : ''}`;
  return row.status === 'confirmed' ? core : `[Tentative] ${core}`;
}

// Remove a leading gym name from a location label, for any gym — the old code
// hardcoded a single gym-name prefix, which silently did nothing for every other gym.
function stripGymPrefix(locationName, gym) {
  if (!gym) return locationName;
  for (const candidate of [gym.name, gym.shortName].filter(Boolean)) {
    const re = new RegExp('^' + candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i');
    if (re.test(locationName)) return locationName.replace(re, '');
  }
  return locationName;
}

function buildSpotLine(row) {
  if (row.status !== 'confirmed' || !row.slot_label) return null;
  const seats = String(row.slot_label).split(',').map(s => s.trim()).filter(Boolean);
  if (seats.length === 0) return null;
  const word = seatWordFor(row.group_name);
  const label = seats.length > 1 ? `${word}s ${seats.join(', ')}` : `${word} ${seats[0]}`;
  let line = `You're on ${label}!`;
  if (row.upgrade_note) line += ` (${row.upgrade_note})`;
  return line;
}

// Strip a leading group/discipline prefix from the class name so we don't render
// "RIDE: RIDE: Signature 45". CodexFit isn't consistent about whether the name is
// prefixed, so we trim it and re-prepend the group ourselves.
// U1-19b: delegates to the shared rule (server/class-name.js, pinned to the
// client's by test-class-name-parity.js). Keeps this file's (group, name) order.
function cleanClassName(group, name) {
  return cleanClassNameShared(name, group) || String(name || '').trim();
}

function buildDescription(row) {
  const start = DateTime.fromISO(row.start_at, { zone: zoneOfGym(row.gym_id) }).setLocale('en-GB');
  const dur = row.duration_min || DEFAULT_DURATION_MIN;
  const statusText = row.status === 'confirmed' ? 'Booked ✓'
    : row.status === 'waitlist' ? 'On waitlist'
    : 'Auto-Book queued — books at release';

  const cleanName = cleanClassName(row.group_name, row.class_name);
  const classLine = row.group_name
    ? `${disciplineHead(row.group_name).toUpperCase()}: ${cleanName}`
    : cleanName;

  const lines = [`Status: ${statusText}`];
  const spot = buildSpotLine(row);
  if (spot) lines.push(spot);
  lines.push('');                       // blank line after status/spot, before class
  lines.push(`Class: ${classLine}`);
  if (instructorFirstName(row.instructor_name)) lines.push(`Instructor: ${row.instructor_name}`);
  lines.push(`Studio: ${[row.studio_name, row.location_name].filter(Boolean).join(', ')}`);
  if (start.isValid) lines.push(`Starts: ${start.toFormat('ccc d LLL, HH:mm')} (${dur} min)`);
  lines.push('');                       // blank line before footer block
  lines.push(`${appName} · https://${APP_HOST}`);
  lines.push('Managed automatically — edits here won\'t sync back.');
  return lines.join('\n');
}

// VALARMs are TARGETED (U4-16). Only a CONFIRMED class gets the 2 h and/or
// free-cancellation-window alarms the member ticked. Waitlist and Auto-Book rows
// are tentative and NEVER carry an alarm: a calendar app would otherwise nag
// about a class the member does not hold.
function buildAlarms(row, reminders) {
  if (row.status !== 'confirmed' || !reminders) return [];
  const title = esc(buildTitle(row));
  const blocks = [];
  const add = (trigger) => blocks.push(
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${title}`, `TRIGGER:${trigger}`, 'END:VALARM'
  );
  if (reminders.twoHour) add('-PT2H');
  if (reminders.cancelWindow) add(`-PT${PENALTY_HOURS}H`);
  return blocks;
}

// ─── "Booking opens" events (weekly-release gyms only) ────────────────────────
// Synthesised at serialisation time from the gym's policy; nothing is stored, so
// there is nothing to reconcile. Selected by bookingWindow.kind, never by gym id.
// UID is deterministic (user + gym + release date in the gym's zone), so a
// refresh re-emits the SAME event instead of duplicating it.
function bookingWindowEvents(gymIds, now = DateTime.now()) {
  const out = [];
  for (const gymId of gymIds) {
    const gym = getGymConfig(gymId);
    if (!gym || !isRollingWeekly(gym)) continue;
    const policy = policyOf(gym);
    const zone = policy.timezone || resolveZone(gym);
    let release = mostRecentRelease(policy, now.setZone(zone));
    while (release <= now) release = release.plus({ weeks: 1 });
    for (let i = 0; i < WINDOW_EVENT_COUNT; i++) {
      out.push({ gymId, gymName: gym.shortName || gym.name || 'Gym', start: release, dateKey: release.toFormat('yyyyLLdd') });
      release = release.plus({ weeks: 1 });
    }
  }
  return out;
}

function buildWindowVEvent(userId, w) {
  const start = w.start;
  const end = start.plus({ minutes: WINDOW_EVENT_DURATION_MIN });
  const title = `${w.gymName} booking window opens`;
  return [
    'BEGIN:VEVENT',
    `UID:app-${userId}-bw-${w.gymId}-${w.dateKey}@${UID_NAMESPACE}`,
    'SEQUENCE:0',
    `DTSTAMP:${fmtUTC(DateTime.now())}`,
    dtProp('DTSTART', start),
    dtProp('DTEND', end),
    `SUMMARY:${esc(title)}`,
    `DESCRIPTION:${esc(`Booking opens for the next classes at ${w.gymName}.\n\n${appName} · https://${APP_HOST}`)}`,
    'STATUS:CONFIRMED',
    `CATEGORIES:${esc(w.gymName)}`,
    'TRANSP:TRANSPARENT',
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, `TRIGGER:-PT${WINDOW_REMINDER_MIN}M`, 'END:VALARM',
    'END:VEVENT',
  ];
}

function buildVEvent(userId, row, addrMap, reminders) {
  const start = DateTime.fromISO(row.start_at, { zone: zoneOfGym(row.gym_id) });
  if (!start.isValid) return [];
  const end = start.plus({ minutes: row.duration_min || DEFAULT_DURATION_MIN });
  // addrMap is { [gymId]: { locationName: address } } (C3-20).
  const address = row.location_address || ((addrMap[row.gym_id] || {})[row.location_name]) || '';
  const locField = [row.location_name, address].filter(Boolean).join(', ');
  const discipline = titleCase(disciplineHead(row.group_name));

  const lines = [
    'BEGIN:VEVENT',
    `UID:app-${userId}-${row.event_id}@${UID_NAMESPACE}`,
    `SEQUENCE:${row.sequence || 0}`,
    `DTSTAMP:${fmtUTC(DateTime.now())}`,
    dtProp('DTSTART', start),
    dtProp('DTEND', end),
    `SUMMARY:${esc(buildTitle(row))}`,
  ];
  if (locField) lines.push(`LOCATION:${esc(locField)}`);
  lines.push(`DESCRIPTION:${esc(buildDescription(row))}`);
  lines.push(`STATUS:${row.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`);
  // Category is the row's own gym, so a calendar client can colour or filter by
  // gym. Hardcoding "Psycle" filed every JAB class under Psycle.
  const catGym = row.gym_id ? getGymConfig(row.gym_id) : null;
  lines.push(`CATEGORIES:${esc((catGym && (catGym.shortName || catGym.name)) || 'Class')}${discipline ? ',' + esc(discipline) : ''}`);
  lines.push('TRANSP:OPAQUE');
  lines.push(...buildAlarms(row, reminders));
  lines.push('END:VEVENT');
  return lines;
}

function serializeCalendar(userId, rows, addrMap, reminders, windowEvents = []) {
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${appName}//Calendar Feed//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${appName}`,
    'X-WR-TIMEZONE:Europe/London',
    'X-PUBLISHED-TTL:PT3H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT3H',
    ...VTIMEZONE,
  ];
  for (const row of rows) out.push(...buildVEvent(userId, row, addrMap, reminders));
  for (const w of windowEvents) out.push(...buildWindowVEvent(userId, w));
  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

// ─── Regenerate a single user's snapshot (DB-only; safe to fire-and-forget) ────
function regenerateSnapshot(userId) {
  try {
    const settings = db.getUserSettings(userId) || {};
    const cal = settings.calendar || {};
    // Read through normalizeCalendarPrefs so a blob saved before U4-16 (one
    // includeTentative flag, one alarm dropdown) yields exactly the same feed.
    const prefs = normalizeCalendarPrefs(cal);
    const nowISO = DateTime.now().toISO();

    // One pass per linked gym, each inside that gym's context so the per-user
    // db accessors (auto-bookings, booking/waitlist cache, upgrade monitors)
    // resolve to it. Reconciliation is also per gym: an unscoped reconcile
    // would see gym A's classes missing from gym B's live list and delete them.
    const gymIds = linkedGymIds(userId);
    const addrMap = Object.fromEntries(gymIds.map((g) => [g, cachedLocationMap(g)]));

    for (const gymId of gymIds) {
      db.runWithGymContext(userId, gymId, () => {
        const live = gatherLiveClasses(userId, gymId);
        const upgradeMap = db.getUserAutoUpgradesByEvent(userId);
        const existingRows = db.getCalendarClasses(userId, gymId);
        const existingByEvent = {};
        for (const r of existingRows) existingByEvent[String(r.event_id)] = r;

        const keepIds = [];
        for (const l of live) {
          keepIds.push(l.eventId);
          db.upsertCalendarClass(userId, buildRecord(l, upgradeMap, existingByEvent), gymId);
        }
        db.reconcileFutureCalendarClasses(userId, nowISO, keepIds, gymId);
      });
    }
    // History cap is account-wide: one calendar, one budget.
    db.capPastCalendarClasses(userId, nowISO, PAST_CLASS_CAP);

    // No gym argument — this is the whole account's calendar.
    let rows = db.getCalendarClasses(userId);
    rows = rows.filter(r => gymIds.includes(r.gym_id) && (r.status === 'confirmed'
      || (r.status === 'waitlist' && prefs.includeWaitlists)
      || (r.status === 'autobook' && prefs.includeAutoBook)));
    const windowEvents = prefs.remindBookingWindow ? bookingWindowEvents(gymIds) : [];
    const ics = serializeCalendar(userId, rows, addrMap, prefs.reminders, windowEvents);
    const etag = '"' + crypto.createHash('md5').update(ics).digest('hex') + '"';
    db.saveCalendarSnapshot(userId, ics, etag, rows.length);
    return { ics, etag, count: rows.length };
  } catch (err) {
    console.error(`[Calendar] regenerate failed for user ${userId}:`, err.message);
    return null;
  }
}

// Called by booking-sync.js after it stored a calendar user's rows: refresh the
// (TTL-cached) location addresses of the gyms just synced, then republish.
async function afterBookingSync(userId, gymIds) {
  for (const gymId of gymIds || []) {
    if (gymOutbound.isOutboundBlocked(gymId, userId)) continue;
    try { await refreshLocationMap(userId, false, gymId); } catch (_) { /* keep cached addresses */ }
  }
  return regenerateSnapshot(userId);
}

// Refresh one account now (after a book/cancel/waitlist action through the app,
// or an explicit feed refresh): a FORCED booking sync, for every account (T-B:
// not only calendar users). `gymIds` names the gyms to sync: a mutation passes
// only the gym it changed, so a member with five gyms costs one fetch, not five;
// null means every enabled gym (explicit refresh, gym link). The sync
// republishes the feed itself when anything was stored; with every gym skipped
// or failed, the feed is still republished from the last good rows.
async function refreshUser(userId, gymIds = null) {
  const only = gymIds == null ? null : [].concat(gymIds).filter(Boolean);
  const synced = await bookingSync.syncUser(userId, { force: true, gymIds: only && only.length ? only : null });
  const settings = db.getUserSettings(userId) || {};
  if (!settings.calendar || !settings.calendar.enabled) return;
  if (!synced.length) regenerateSnapshot(userId);
  console.log(`[Calendar] Refreshed + published snapshot for user ${userId} (${synced.length} gym(s) synced).`);
}

// Debounced one-shot refresh, fired ~1 min after an in-app booking mutation so the
// feed reflects the change without waiting for the cycle. Coalesces bursts: one
// timer per account, collecting the gyms named while it waits (a call without a
// gym widens it to every gym).
const refreshTimers = new Map(); // userId -> { timer, gyms: Set | null (all) }
function scheduleRefresh(userId, delayMs = 60000, gymId = null) {
  const pending = refreshTimers.get(userId);
  if (pending) {
    if (!gymId) pending.gyms = null;
    else if (pending.gyms) pending.gyms.add(gymId);
    return;
  }
  const entry = { timer: null, gyms: gymId ? new Set([gymId]) : null };
  entry.timer = setTimeout(() => {
    refreshTimers.delete(userId);
    refreshUser(userId, entry.gyms ? [...entry.gyms] : null)
      .catch(err => console.error(`[Calendar] scheduled refresh failed for user ${userId}:`, err.message));
  }, delayMs);
  if (entry.timer.unref) entry.timer.unref();
  refreshTimers.set(userId, entry);
}

// ─── 3-hourly republish for all feed users (DB only; T-B) ──────────────────────
// No provider calls: booking-sync.js keeps the rows fresh (3 h cadence for feed
// users) and republishes after each sync. This pass catches what changes without
// a sync: auto-book queue edits, upgrade notes, booking-window reminder events
// and classes moving into the past.
async function pollAndPublishAll() {
  const userIds = db.getCalendarEnabledUserIds();
  for (const userId of userIds) {
    try { regenerateSnapshot(userId); }
    catch (err) { console.error(`[Calendar] republish failed for user ${userId}:`, err.message); }
  }
  // Housekeeping: drop stale waitlist rows for past classes.
  try { db.pruneWaitlistCache(DateTime.now().toISO()); } catch (_) {}
}

module.exports = {
  init() {
    console.log('[Calendar] Calendar feed service initialized.');
    // Liveness heartbeat for /api/health (seed now, refresh each cron tick).
    db.setKV('heartbeat:calendar', Date.now().toString());
    cron.schedule('0 */3 * * *', async () => {
      db.setKV('heartbeat:calendar', Date.now().toString());
      console.log('[Calendar] Running 3-hourly republish cycle...');
      await pollAndPublishAll();
    });
    setTimeout(() => { pollAndPublishAll().catch(() => {}); }, 60000 + Math.floor(Math.random() * 30000));
  },
  ensureToken,
  rotateToken,
  buildLinks,
  buildTitle,
  serializeCalendar,
  bookingWindowEvents,
  regenerateSnapshot,
  pollAndPublishAll,
  refreshUser,
  afterBookingSync,
  scheduleRefresh,
  refreshLocationMap,
  cachedLocationMap,
  // Exposed for direct testing of the WP-N3 adapter-routing swap (test-calendar-feed.js),
  // same rationale poller.js exports fetchCodexFit for calendar.js's own reuse.
  listWithRelogin,
  fetchUserBookings,
  fetchUserWaitlists,
  escapeIcsText: esc, // exposed for test-security-part2.js
};
