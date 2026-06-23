const { DateTime } = require('luxon');
const db = require('./db');
const pushService = require('./push');

const ZONE = 'Europe/London';

// Default notification preferences. Stored per-user under settings.notifications.
const DEFAULT_PREFS = {
  booking: { enabled: true, scope: 'all' },          // scope: 'all' | 'autobook'
  upgrade: { enabled: true },
  creditWarning: { enabled: true },
  cancellationReminder: { enabled: true, timing: '24h' }, // timing: '24h' | '14h'
  bookingWindow: { enabled: true },
};

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

function groupToken(groupName, className) {
  const g = (groupName || '').trim();
  if (g) return g.toUpperCase();
  // Fallback: if the class name leads with an uppercase word, use it; else generic.
  const lead = (className || '').trim().split(/\s+/)[0];
  return lead ? lead.toUpperCase() : 'CLASS';
}

// "Fri 06:30" when the class is ≤6 days away; "Fri 19 Jun 06:30" when further out.
function formatDayTime(startAt) {
  const dt = DateTime.fromISO(startAt, { zone: ZONE });
  if (!dt.isValid) return '';
  const now = DateTime.now().setZone(ZONE);
  const days = dt.startOf('day').diff(now.startOf('day'), 'days').days;
  const time = dt.toFormat('HH:mm');
  if (days <= 6) return `${dt.toFormat('ccc')} ${time}`;
  return `${dt.toFormat('ccc d LLL')} ${time}`;
}

function formatTime(startAt) {
  const dt = DateTime.fromISO(startAt, { zone: ZONE });
  return dt.isValid ? dt.toFormat('HH:mm') : '';
}

function spotsLabel(slots) {
  const arr = Array.isArray(slots) ? slots : [slots];
  const clean = arr.filter(s => s != null && s !== '');
  return clean.join(', ');
}

// ─── Body builders ───────────────────────────────────────────────────────────

function buildBooking(ctx) {
  const spots = spotsLabel(ctx.slots);
  const spotPart = spots ? ` - Spot ${spots}` : '';
  return {
    title: 'Psycle: Spot Booked',
    body: `${formatDayTime(ctx.startAt)} ${groupToken(ctx.groupName, ctx.className)} with ${firstName(ctx.instructorName)}${spotPart}.`,
  };
}

function buildUpgrade(ctx) {
  let body = `You're now on Spot ${ctx.slot} for ${formatDayTime(ctx.startAt)} ${groupToken(ctx.groupName, ctx.className)} with ${firstName(ctx.instructorName)}.`;
  if (ctx.keptOriginal) {
    body += ' Your previous spot was not cancelled, speak to Psycle to cancel without penalty.';
  }
  return { title: 'Psycle: Spot Upgraded', body };
}

function buildCreditWarning(ctx) {
  const dt = formatDayTime(ctx.startAt);
  const grp = groupToken(ctx.groupName, ctx.className);
  const who = firstName(ctx.instructorName);
  let body;
  if (ctx.kind === 'autoupgrade') {
    body = `Auto-Upgrade is enabled for ${dt} ${grp} with ${who}, but I need a spare credit to make the booking. Buy more credits.`;
  } else {
    const spots = ctx.spots || 1;
    const Y = Math.max(1, ctx.creditsShort || 1);
    const spotsClause = spots > 1 ? `for ${spots} spots in` : 'for';
    body = `Auto-Book was set up ${spotsClause} ${dt} ${grp} with ${who}, but you don't have enough credits. Buy ${Y} more credit${Y !== 1 ? 's' : ''}.`;
  }
  return { title: 'Psycle: Credit Warning', body };
}

function buildCancellationReminder(ctx) {
  const start = DateTime.fromISO(ctx.startAt, { zone: ZONE });
  const hoursUntil = start.isValid ? start.diff(DateTime.now().setZone(ZONE), 'hours').hours : 0;
  const freeHours = Math.max(0, Math.round(hoursUntil - 12));
  const spotPart = ctx.slot != null && ctx.slot !== '' ? ` (Spot ${ctx.slot})` : '';
  return {
    title: 'Reminder: Psycle Class',
    body: `You're booked for ${formatTime(ctx.startAt)} ${groupToken(ctx.groupName, ctx.className)} with ${firstName(ctx.instructorName)}${spotPart}. You have ${freeHours} hour${freeHours !== 1 ? 's' : ''} to cancel for free.`,
  };
}

function buildBookingWindow(tip) {
  return {
    title: 'Psycle: Booking Window',
    body: `Psycle booking opens in 1 hour.\n${tip || ''}`.trimEnd(),
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
      built = buildBookingWindow(ctx.tip);
      break;
    default:
      return;
  }
  await pushService.sendNotification(userId, built.title, built.body, { type });
}

// ─── Debug samples (force-send, ignore prefs) ────────────────────────────────

function buildSample(type) {
  const soon = DateTime.now().setZone(ZONE).plus({ days: 1 }).set({ hour: 6, minute: 30, second: 0 }).toISO();
  const base = { startAt: soon, groupName: 'RIDE', className: 'Signature 45', instructorName: 'Aanya Smith', slots: [5], slot: 5 };
  switch (type) {
    case 'booking': return buildBooking(base);
    case 'upgrade': return buildUpgrade({ ...base, keptOriginal: false });
    case 'upgrade-cutoff': return buildUpgrade({ ...base, keptOriginal: true });
    case 'creditWarning': return buildCreditWarning({ ...base, kind: 'autobook', spots: 2, creditsShort: 2 });
    case 'creditWarning-upgrade': return buildCreditWarning({ ...base, kind: 'autoupgrade' });
    case 'cancellationReminder':
      return buildCancellationReminder({ ...base, startAt: DateTime.now().setZone(ZONE).plus({ hours: 24 }).toISO() });
    case 'bookingWindow': return buildBookingWindow('You have 3 classes set to Auto-Book.');
    case 'bookingWindow-none': return buildBookingWindow("Don't forget to set up Auto-Book!");
    case 'bookingWindow-nocredits': return buildBookingWindow('⚠️ You have 3 classes set to Auto-Book, but you don\'t have enough credits.');
    default: return null;
  }
}

async function sendSample(userId, type) {
  const built = buildSample(type);
  if (!built) throw new Error('Unknown notification type: ' + type);
  await pushService.sendNotification(userId, built.title, built.body, { type, sample: true });
}

module.exports = {
  DEFAULT_PREFS,
  getPrefs,
  notify,
  sendSample,
  buildSample,
  // formatting helpers (used by the reminder engine)
  formatDayTime,
  formatTime,
  firstName,
  groupToken,
};
