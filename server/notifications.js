const { DateTime } = require('luxon');
const { disciplineHead } = require('./class-name');
const db = require('./db');
const pushService = require('./push');
const { getGymConfig, listEnabledGyms } = require('./gyms.config');
const { isRollingWeekly } = require('./providers/booking-window');
const { appName } = require('./config');

const { zoneOfGym } = require('./providers/timezone');
// Display zone for a notification: the gym it is about, never a literal.
const zoneFor = (gymId) => zoneOfGym(gymId);

// Default notification preferences. Stored per-user under settings.notifications.
const DEFAULT_PREFS = {
  booking: { enabled: true, scope: 'all' },          // scope: 'all' | 'autobook'
  upgrade: { enabled: true },
  creditWarning: { enabled: true },
  cancellationReminder: { enabled: true, timing: '24h' }, // timing: '24h' | '14h'
  bookingWindow: { enabled: true },
  // C2-3: the provider is rate-limiting/blocking us, so auto-book has paused
  // for that gym. Minimal by design — no scope/timing sub-options, since
  // there's exactly one situation it fires for and no useful variant of it.
  providerThrottled: { enabled: true },
};

/**
 * Is the booking-window reminder on for THIS gym?
 *
 * Three layers, most specific first:
 *   1. the member's own per-gym override (`bookingWindow.byGym[gymId]`)
 *   2. the gym's configured default (`gyms.config.js → notifications`)
 *   3. the gym's booking-window KIND — only a gym that releases at one moment a
 *      week has anything to warn about, so a gym that omits the setting gets a
 *      sensible answer instead of a guess.
 *
 * `bookingWindow.enabled` stays the account-level master switch: off means no
 * booking-window pushes from any gym.
 */
function bookingWindowEnabledForGym(userId, gymId) {
  const prefs = getPrefs(userId);
  if (!prefs.bookingWindow.enabled) return false;

  const cfg = getGymConfig(gymId);
  if (!cfg) return false;
  // A rolling / per-class window has no single periodic release to announce: ALWAYS off,
  // whatever the member's stored override (the UI shows the control disabled).
  if (!isRollingWeekly(cfg)) return false;

  const override = (prefs.bookingWindow.byGym || {})[gymId];
  if (typeof override === 'boolean') return override;

  if (typeof cfg.notifications?.bookingWindowReminder === 'boolean') {
    return cfg.notifications.bookingWindowReminder;
  }
  return isRollingWeekly(cfg);
}

// Merge a user's stored prefs over the defaults (shallow per-type merge).
function getPrefs(userId) {
  const settings = db.getUserSettings(userId) || {};
  const n = settings.notifications || {};
  const merged = {};
  for (const key of Object.keys(DEFAULT_PREFS)) {
    merged[key] = { ...DEFAULT_PREFS[key], ...(n[key] || {}) };
  }
  return merged;
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function firstName(fullName) {
  if (!fullName) return 'your instructor';
  const first = String(fullName).trim().split(/\s+/)[0];
  return first || 'your instructor';
}

// " with Aanya" or "" — U1-16. A missing instructor used to render the literal
// "with your instructor" (firstName's fallback), which read as a bug for any
// class whose payload carried no instructor. Omit the clause instead.
function withInstructor(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0];
  return first ? ` with ${first}` : '';
}

function groupToken(groupName, className) {
  // U1-19b: JAB's `discipline` can be the whole class name ("TRAIN - Lower
  // (Focus)"); a push body names the discipline, so take its head only.
  const g = disciplineHead(groupName);
  if (g) return g.toUpperCase();
  // Fallback: if the class name leads with an uppercase word, use it; else generic.
  const lead = (className || '').trim().split(/\s+/)[0];
  return lead ? lead.toUpperCase() : 'CLASS';
}

// "Fri 06:30" when the class is ≤6 days away; "Fri 19 Jun 06:30" when further out.
function formatDayTime(startAt, zone = zoneFor()) {
  const dt = DateTime.fromISO(startAt, { zone });
  if (!dt.isValid) return '';
  const now = DateTime.now().setZone(zone);
  const days = dt.startOf('day').diff(now.startOf('day'), 'days').days;
  const time = dt.toFormat('HH:mm');
  if (days <= 6) return `${dt.toFormat('ccc')} ${time}`;
  return `${dt.toFormat('ccc d LLL')} ${time}`;
}

function formatTime(startAt, zone = zoneFor()) {
  const dt = DateTime.fromISO(startAt, { zone });
  return dt.isValid ? dt.toFormat('HH:mm') : '';
}

function spotsLabel(slots) {
  const arr = Array.isArray(slots) ? slots : [slots];
  const clean = arr.filter(s => s != null && s !== '');
  return clean.join(', ');
}

// ─── Gym naming (C3-5) ───────────────────────────────────────────────────────
//
// Every title/body below used to hardcode "Psycle" — true only for a
// single-gym build. `ctx.gymId` is how every notify() caller (see below) names
// the gym a notification is actually about; falling back to a generic label
// rather than throwing keeps a caller that forgets it from crashing a
// push send outright, but every real call site names its own gym explicitly.
function gymShortName(gymId) {
  const cfg = getGymConfig(gymId);
  return (cfg && cfg.shortName) || 'Your gym';
}

// ─── Body builders ───────────────────────────────────────────────────────────

function buildBooking(ctx) {
  const gym = gymShortName(ctx.gymId);
  const spots = spotsLabel(ctx.slots);
  const spotPart = spots ? ` - Spot ${spots}` : '';
  return {
    title: `${gym}: Spot Booked`,
    body: `${formatDayTime(ctx.startAt, zoneFor(ctx.gymId))} ${groupToken(ctx.groupName, ctx.className)}${withInstructor(ctx.instructorName)}${spotPart}.`,
  };
}

function buildUpgrade(ctx) {
  const gym = gymShortName(ctx.gymId);
  let body = `You're now on Spot ${ctx.slot} for ${formatDayTime(ctx.startAt, zoneFor(ctx.gymId))} ${groupToken(ctx.groupName, ctx.className)}${withInstructor(ctx.instructorName)}.`;
  if (ctx.keptOriginal) {
    body += ` Your previous spot was not cancelled, speak to ${gym} to cancel without penalty.`;
  }
  return { title: `${gym}: Spot Upgraded`, body };
}

function buildCreditWarning(ctx) {
  const gym = gymShortName(ctx.gymId);
  const dt = formatDayTime(ctx.startAt, zoneFor(ctx.gymId));
  const grp = groupToken(ctx.groupName, ctx.className);
  const who = withInstructor(ctx.instructorName);
  let body;
  if (ctx.kind === 'autoupgrade') {
    body = `Auto-Upgrade is enabled for ${dt} ${grp}${who}, but I need a spare credit to make the booking. Buy more credits.`;
  } else {
    const spots = ctx.spots || 1;
    const Y = Math.max(1, ctx.creditsShort || 1);
    const spotsClause = spots > 1 ? `for ${spots} spots in` : 'for';
    body = `Auto-Book was set up ${spotsClause} ${dt} ${grp}${who}, but you don't have enough credits. Buy ${Y} more credit${Y !== 1 ? 's' : ''}.`;
  }
  return { title: `${gym}: Credit Warning`, body };
}

function buildCancellationReminder(ctx) {
  const gym = gymShortName(ctx.gymId);
  const start = DateTime.fromISO(ctx.startAt, { zone: zoneFor(ctx.gymId) });
  const hoursUntil = start.isValid ? start.diff(DateTime.now(), 'hours').hours : 0;
  const freeHours = Math.max(0, Math.round(hoursUntil - 12));
  const spotPart = ctx.slot != null && ctx.slot !== '' ? ` (Spot ${ctx.slot})` : '';
  return {
    title: `Reminder: ${gym} Class`,
    body: `You're booked for ${formatTime(ctx.startAt, zoneFor(ctx.gymId))} ${groupToken(ctx.groupName, ctx.className)}${withInstructor(ctx.instructorName)}${spotPart}. You have ${freeHours} hour${freeHours !== 1 ? 's' : ''} to cancel for free.`,
  };
}

function buildProviderThrottled(ctx) {
  const gymName = (getGymConfig(ctx.gymId) || {}).name || 'The gym';
  return {
    title: `${gymName}: Booking Paused`,
    body: `${gymName} is rate-limiting requests right now, so I've paused Auto-Book for this gym and will resume automatically once it clears.`,
  };
}

function buildBookingWindow(ctx) {
  const gym = gymShortName(ctx.gymId);
  return {
    title: `${gym}: Booking Window`,
    body: `${gym} booking opens in 1 hour.\n${ctx.tip || ''}`.trimEnd(),
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

// Send a notification of the given type, honouring the user's preferences.
async function notify(userId, type, ctx = {}) {
  const prefs = getPrefs(userId);
  let built;
  switch (type) {
    case 'booking':
      if (!prefs.booking.enabled) return;
      if (prefs.booking.scope === 'autobook' && ctx.source !== 'autobook') return;
      built = buildBooking(ctx);
      break;
    case 'upgrade':
      if (!prefs.upgrade.enabled) return;
      built = buildUpgrade(ctx);
      break;
    case 'creditWarning':
      if (!prefs.creditWarning.enabled) return;
      built = buildCreditWarning(ctx);
      break;
    case 'cancellationReminder':
      if (!prefs.cancellationReminder.enabled) return;
      built = buildCancellationReminder(ctx);
      break;
    case 'bookingWindow':
      if (!prefs.bookingWindow.enabled) return;
      built = buildBookingWindow(ctx);
      break;
    case 'providerThrottled':
      if (!prefs.providerThrottled.enabled) return;
      built = buildProviderThrottled(ctx);
      break;
    default:
      return;
  }
  await pushService.sendNotification(userId, built.title, built.body, { type });
}

// ─── Debug samples (force-send, ignore prefs) ────────────────────────────────

function buildSample(type) {
  // Samples describe the first enabled gym in the registry; no gym is privileged.
  const sampleGymId = (listEnabledGyms()[0] || {}).id;
  const soon = DateTime.now().setZone(zoneFor(sampleGymId)).plus({ days: 1 }).set({ hour: 6, minute: 30, second: 0 }).toISO();
  const base = { startAt: soon, groupName: 'RIDE', className: 'Signature 45', instructorName: 'Aanya Smith', slots: [5], slot: 5, gymId: sampleGymId };
  switch (type) {
    case 'booking': return buildBooking(base);
    case 'upgrade': return buildUpgrade({ ...base, keptOriginal: false });
    case 'upgrade-cutoff': return buildUpgrade({ ...base, keptOriginal: true });
    case 'creditWarning': return buildCreditWarning({ ...base, kind: 'autobook', spots: 2, creditsShort: 2 });
    case 'creditWarning-upgrade': return buildCreditWarning({ ...base, kind: 'autoupgrade' });
    case 'cancellationReminder':
      return buildCancellationReminder({ ...base, startAt: DateTime.now().setZone(zoneFor(sampleGymId)).plus({ hours: 24 }).toISO() });
    case 'bookingWindow': return buildBookingWindow({ gymId: sampleGymId, tip: 'You have 3 classes set to Auto-Book.' });
    case 'bookingWindow-none': return buildBookingWindow({ gymId: sampleGymId, tip: "Don't forget to set up Auto-Book!" });
    case 'bookingWindow-nocredits': return buildBookingWindow({ gymId: sampleGymId, tip: '⚠️ You have 3 classes set to Auto-Book, but you don\'t have enough credits.' });
    case 'providerThrottled': return buildProviderThrottled({ gymId: sampleGymId });
    default: return null;
  }
}

// Generic "is push working" notification. The only push that names the APP
// rather than a gym, so its text comes from the instance config.
function buildGenericTest() {
  return { title: `${appName}: Test Notification`, body: `Your ${appName} server is ready to notify you!` };
}

async function sendGenericTest(userId) {
  const built = buildGenericTest();
  await pushService.sendNotification(userId, built.title, built.body, { type: 'test' });
}

async function sendSample(userId, type) {
  const built = buildSample(type);
  if (!built) throw new Error('Unknown notification type: ' + type);
  await pushService.sendNotification(userId, built.title, built.body, { type, sample: true });
}

module.exports = {
  DEFAULT_PREFS,
  getPrefs,
  bookingWindowEnabledForGym,
  notify,
  sendSample,
  buildSample,
  buildGenericTest,
  sendGenericTest,
  // formatting helpers (used by the reminder engine)
  formatDayTime,
  formatTime,
  firstName,
  withInstructor,
  groupToken,
};
