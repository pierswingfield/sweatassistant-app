// Share My Bookings (F-3 weekly export): pure selection + text formatting.
// No DOM here, so the window, TBC and per-gym time zone rules are unit tested
// (share-bookings.test.js). The drawer lives in share-sheet.js.
import { zoneFor, formatInZone, noSept } from '../lib.js';
import { getGymShortName } from '../gym-context.js';
import { trimLocation, escapeHtml, getDiscipline } from './cards.js';
import { COPY, formatCopyText } from '../copy.js';

export const SHARE_WINDOWS = Object.freeze([
  { id: '3d', days: 3, label: 'Next 3 days', heading: '3 Days' },
  { id: '1w', days: 7, label: '1 week', heading: '7 Days' },
  { id: '2w', days: 14, label: '2 weeks', heading: '14 Days' },
]);
export const DEFAULT_SHARE_WINDOW = '1w';

const startOf = (e) => e?.startAt || e?.start_at || '';

function baseItem(kind, gymId, eventId, startAt, zone, className, discipline, locationName, instructor) {
  const gym = getGymShortName(gymId);
  return {
    kind, gymId, eventId: String(eventId ?? ''), startAt, zone,
    gymName: gym,
    // The semantic group in sentence case ("Ride", "Train"), grouped exactly as the cards do;
    // never the class name ("TRAIN - Chest, Back and Arms" is just "Train").
    classType: getDiscipline(discipline || className || '').label,
    location: trimLocation(locationName || '', gym),
    instructor: instructor || '',
  };
}

/**
 * Flatten the three sources into one list of share items.
 * Confirmed bookings are grouped by event (extra spots/guests are ONE class);
 * a pending auto-book for an event that is already booked is dropped.
 */
export function buildShareItems({ bookings = [], waitlists = [], autoBooks = [] } = {}) {
  const items = [];
  const seen = new Set();
  const key = (gymId, eventId) => `${gymId}:${eventId}`;

  for (const b of bookings) {
    const e = b.event;
    if (!e || !startOf(e)) continue;
    const gymId = e.gymId || b.gymId || b.gym_id || '';
    const eventId = e.id ?? b.eventId ?? b.event_id;
    const k = key(gymId, eventId);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(baseItem('confirmed', gymId, eventId, startOf(e), zoneFor(e, gymId),
      e.name || e.event_type?.name, e.discipline || e.event_type?.group?.name,
      e.locationName || e.studio?.location?.name, e.instructors?.[0]?.name || e.instructor?.full_name));
  }
  for (const w of waitlists) {
    const e = w.event;
    if (!e || !startOf(e)) continue;
    const gymId = e.gymId || w.gymId || w.gym_id || '';
    const eventId = e.id ?? w.eventId ?? w.event_id;
    const k = key(gymId, eventId);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(baseItem('waitlist', gymId, eventId, startOf(e), zoneFor(e, gymId),
      e.name || e.event_type?.name, e.discipline || e.event_type?.group?.name,
      e.locationName || e.studio?.location?.name, e.instructors?.[0]?.name || e.instructor?.full_name));
  }
  for (const a of autoBooks) {
    if (a.status && a.status !== 'pending') continue;
    const gymId = a.gym_id || a.gymId || '';
    const k = key(gymId, a.event_id);
    if (!a.start_at || seen.has(k)) continue;
    seen.add(k);
    items.push(baseItem('autobook', gymId, a.event_id, a.start_at, zoneFor(a, gymId),
      a.class_name, a.group_name, a.location_name, a.instructor_name));
  }
  return items.sort((x, y) => Date.parse(x.startAt) - Date.parse(y.startAt));
}

/** Items starting between `now` and now + window, in the chosen gyms, TBC optional. */
export function filterShareItems(items, { windowId = DEFAULT_SHARE_WINDOW, gymIds = null, includeTbc = true, now = Date.now() } = {}) {
  const win = SHARE_WINDOWS.find((w) => w.id === windowId) || SHARE_WINDOWS[1];
  const end = now + win.days * 24 * 3600 * 1000;
  const gyms = gymIds ? new Set(gymIds.map(String)) : null;
  return items.filter((i) => {
    const t = Date.parse(i.startAt);
    if (!Number.isFinite(t) || t < now || t > end) return false;
    if (gyms && !gyms.has(String(i.gymId))) return false;
    if (!includeTbc && i.kind !== 'confirmed') return false;
    return true;
  });
}

export function countShareItems(items) {
  const tbc = items.filter((i) => i.kind !== 'confirmed').length;
  return { total: items.length, tbc };
}

/** "Piers's", "Chris's": always 's, as the product copy specifies. */
export function possessive(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  return `${n}'s`;
}

function tag(kind) {
  if (kind === 'waitlist') return ' (waitlist)';
  if (kind === 'autobook') return ' (auto-book, TBC)';
  return '';
}

/** Share document: a title, days of lines, an optional footer. Rendered to text and HTML below. */
export function buildShareDoc(items, { name = '', windowId = DEFAULT_SHARE_WINDOW, appName = '' } = {}) {
  const win = SHARE_WINDOWS.find((w) => w.id === windowId) || SHARE_WINDOWS[1];
  const who = possessive(name);
  const days = [];
  for (const i of items) {
    const fmt = formatInZone(i.startAt, i.zone);
    const date = noSept(fmt.date);
    if (!days.length || days[days.length - 1].date !== date) days.push({ date, lines: [] });
    // Gym-local time; a zone suffix only when it is a short code ("ET"), never a long generic name.
    const time = fmt.suffix && fmt.suffix.length <= 5 ? fmt.timeLabel : fmt.time;
    const what = `${i.gymName ? `${i.gymName} - ` : ''}${i.classType}${i.instructor ? ` with ${i.instructor}` : ''}`;
    days[days.length - 1].lines.push({ time, rest: `${what}${i.location ? ` · ${i.location}` : ''}${tag(i.kind)}` });
  }
  return {
    title: `${who ? `${who} Classes` : 'My Classes'} - ${win.heading}`,
    days,
    footer: appName ? formatCopyText(COPY.share.footer, { app: appName }) : '',
  };
}

export function renderSharePlain(doc) {
  const out = [doc.title];
  for (const d of doc.days) {
    out.push('', d.date.toUpperCase());
    for (const l of d.lines) out.push(`• ${l.time} ${l.rest}`);
  }
  if (doc.footer) out.push('', doc.footer);
  return out.join('\n');
}

export function renderShareHtml(doc) {
  const days = doc.days.map((d) => `<p><strong>${escapeHtml(d.date.toUpperCase())}</strong></p><ul>${d.lines.map((l) =>
    `<li><strong>${escapeHtml(l.time)}</strong> ${escapeHtml(l.rest)}</li>`).join('')}</ul>`).join('');
  return `<p>${escapeHtml(doc.title)}</p>${days}${doc.footer ? `<p>${escapeHtml(doc.footer)}</p>` : ''}`;
}

/** Both flavours: `text` for plain targets and the native share sheet, `html` for rich paste (email, Notes, Docs). */
export function formatShare(items, opts) {
  const doc = buildShareDoc(items, opts);
  return { text: renderSharePlain(doc), html: renderShareHtml(doc) };
}

/** Gyms that have at least one upcoming class (of any kind) to share. */
export function gymsWithUpcoming(items, now = Date.now()) {
  const ids = [];
  for (const i of items) {
    if (Date.parse(i.startAt) >= now && !ids.includes(String(i.gymId))) ids.push(String(i.gymId));
  }
  return ids;
}

/** First name from whichever gym profile carries one (normalized or raw CodexFit shape). */
export function pickFirstName(profiles = []) {
  for (const p of profiles) {
    const n = p && (p.firstName || p.first_name || p.data?.first_name);
    if (n && String(n).trim()) return String(n).trim();
  }
  return '';
}
