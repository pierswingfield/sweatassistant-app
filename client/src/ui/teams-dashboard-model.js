// T-3 Team dashboard models (PLAN-teams.md §5.3). Pure: the server's projection in,
// widget rows out. Nothing here widens what the viewer may see: every class, attendee
// and gym in the input already passed server/team-projection.js (§2 principle 1), so
// these functions only arrange it. Clocks and zones are inputs.
//
// A projected class: { key, gymId, eventId, startAt (ISO, class zone), timeZone,
// durationMin, className, discipline, instructorName, studioName, locationName,
// status, attendees: [{ memberRef, kind: booked|waitlist|queued, spot? }] }.

import { DateTime } from 'luxon';

export const WEEK_DAYS = 7;
export const WEEK_ROWS_MAX = 3;
export const DEFAULT_DURATION_MIN = 45; // server/team-mascot.js DEFAULT_DURATION_MIN

export function startMsOf(c) {
  const t = Date.parse(c && c.startAt);
  return Number.isFinite(t) ? t : NaN;
}

export function endMsOf(c) {
  const d = Number(c && c.durationMin) > 0 ? Number(c.durationMin) : DEFAULT_DURATION_MIN;
  return startMsOf(c) + d * 60000;
}

export const bookedOf = (c) => ((c && c.attendees) || []).filter((a) => a && a.kind === 'booked');

/** done | inProgress | upcoming at `now` (recomputed client-side so a long-open page stays right). */
export function statusAt(c, now) {
  const s = startMsOf(c);
  const e = endMsOf(c);
  if (e <= now) return 'done';
  if (s <= now) return 'inProgress';
  return 'upcoming';
}

/** The class's calendar day in ITS OWN zone (the server's "today" rule, §5.4). */
export function classDayKey(c) {
  const dt = DateTime.fromISO(String(c && c.startAt), { setZone: true });
  if (!dt.isValid) return '';
  const z = c.timeZone ? dt.setZone(c.timeZone) : dt;
  return (z.isValid ? z : dt).toISODate();
}

function todayKeyFor(c, now) {
  const z = c.timeZone || 'UTC';
  const dt = DateTime.fromMillis(now, { zone: z });
  return (dt.isValid ? dt : DateTime.fromMillis(now, { zone: 'UTC' })).toISODate();
}

const byStart = (a, b) => (startMsOf(a) - startMsOf(b)) || String(a.key).localeCompare(String(b.key));

/**
 * Today's workouts (§5.3 item 2): every visible class today with at least one booked
 * member, past, ongoing and upcoming, in time order. In-progress rows carry the ring
 * fraction and minutes left.
 */
export function todaysWorkouts(classes, { now }) {
  return (classes || [])
    .filter((c) => bookedOf(c).length && classDayKey(c) === todayKeyFor(c, now))
    .sort(byStart)
    .map((c) => {
      const status = statusAt(c, now);
      const s = startMsOf(c);
      const e = endMsOf(c);
      const progress = status === 'done' ? 1 : status === 'inProgress' ? Math.max(0, Math.min(1, (now - s) / Math.max(1, e - s))) : 0;
      const minutesLeft = status === 'inProgress' ? Math.max(1, Math.ceil((e - now) / 60000)) : null;
      return { cls: c, status, progress, minutesLeft };
    });
}

/**
 * This week (§5.3 item 3): seven days from today in the viewer's zone. Each day lists
 * its classes (any attendee kind) and the distinct members on it, for the strip's dots.
 */
export function weekDays(classes, { now, zone = 'UTC', days = WEEK_DAYS }) {
  let base = DateTime.fromMillis(now, { zone });
  if (!base.isValid) base = DateTime.fromMillis(now, { zone: 'UTC' });
  base = base.startOf('day');
  const out = [];
  const index = new Map();
  for (let i = 0; i < days; i++) {
    const d = base.plus({ days: i });
    const day = { date: d.toISODate(), weekday: d.toFormat('ccc'), dayNum: d.day, isToday: i === 0, classes: [], memberRefs: [] };
    index.set(day.date, day);
    out.push(day);
  }
  for (const c of [...(classes || [])].sort(byStart)) {
    if (!(c.attendees || []).length) continue;
    const day = index.get(classDayKey(c));
    if (!day) continue;
    day.classes.push(c);
    for (const a of c.attendees) if (!day.memberRefs.includes(a.memberRef)) day.memberRefs.push(a.memberRef);
  }
  return out;
}

/** The strip opens on the day with the next class that has not ended (today or later), else today. */
export function initialDayIndex(days, now) {
  const i = (days || []).findIndex((d) => d.classes.some((c) => endMsOf(c) > now));
  return i < 0 ? 0 : i;
}

/** At most `max` rows, then "See more (n)". */
export function visibleWeekRows(list, expanded, max = WEEK_ROWS_MAX) {
  const all = list || [];
  if (expanded || all.length <= max) return { rows: all, hidden: 0 };
  return { rows: all.slice(0, max), hidden: all.length - max };
}

/** Classes together (§5.3 item 4): not yet started, two or more booked members, chronological. */
export function classesTogether(classes, { now }) {
  return (classes || []).filter((c) => startMsOf(c) > now && bookedOf(c).length >= 2).sort(byStart);
}

/**
 * Per member: the class they're in now and their next shared class, from the visible
 * classes only (a class at a gym the viewer hasn't linked is not in the input).
 * @returns {Map<string, { inClass: object|null, next: object|null, spotIn: string, spotNext: string }>}
 */
export function memberActivity(members, classes, { now }) {
  const out = new Map((members || []).map((m) => [m.memberRef, { inClass: null, next: null, spotIn: '', spotNext: '' }]));
  for (const c of [...(classes || [])].sort(byStart)) {
    const status = statusAt(c, now);
    if (status === 'done') continue;
    for (const a of bookedOf(c)) {
      const row = out.get(a.memberRef);
      if (!row) continue;
      if (status === 'inProgress' && !row.inClass) { row.inClass = c; row.spotIn = a.spot || ''; }
      if (status === 'upcoming' && !row.next) { row.next = c; row.spotNext = a.spot || ''; }
    }
  }
  return out;
}

/** Sort key for "activity": this week first, then this month. Private counts sort last. */
export function activityScore(member) {
  const c = member && member.counts;
  if (!c) return -1;
  return (Number(c.week) || 0) * 1000 + (Number(c.month) || 0);
}

/**
 * Header state (§5.3 item 1): names of the visible members in class now (viewer as
 * "You" handled by the caller), plus the day's done/total from the server's totals,
 * which include other gyms (§4).
 */
export function heroState(data, { now }) {
  const members = new Map(((data && data.members) || []).map((m) => [m.memberRef, m]));
  const inClass = [];
  for (const c of (data && data.classes) || []) {
    if (statusAt(c, now) !== 'inProgress') continue;
    for (const a of bookedOf(c)) {
      const m = members.get(a.memberRef);
      if (m && !inClass.includes(m)) inClass.push(m);
    }
  }
  const t = (data && data.today) || {};
  return {
    inClass,
    inProgress: Number(t.inProgress) || 0,
    done: Number(t.done) || 0,
    total: Number(t.total) || 0,
  };
}

/** "Ana", "Ana and Sam", "Ana, Sam and 2 more". */
export function namesList(names, { and = 'and', more = '{count} more', max = 2 } = {}) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length <= max) return `${list.slice(0, -1).join(', ')} ${and} ${list[list.length - 1]}`;
  return `${list.slice(0, max).join(', ')} ${and} ${more.replace('{count}', String(list.length - max))}`;
}

/**
 * Which Classes-together CTA to show. The booking itself always runs through the
 * timetable's existing action model (`event`); this only decides around it.
 *   in       the viewer is booked (their own projected attendee row, or their bookings)
 *   turnOn   the viewer linked this gym but switched it off (§4: "Turn on Gym")
 *   event    the class is in the loaded timetable: delegate to its primary action
 *   timetable  not loaded yet: open the Timetable
 */
export function ctaKind({ cls, myRef, bookedByMe = false, gymDisabled = false, eventFound = false }) {
  if (bookedByMe || bookedOf(cls).some((a) => a.memberRef === myRef)) return 'in';
  if (gymDisabled) return 'turnOn';
  return eventFound ? 'event' : 'timetable';
}

/** A member's Team-scoped profile (§5.3 item 5): what they shared, as this viewer may see it. */
export function memberProfile(memberRef, data, { now }) {
  const has = (c) => (c.attendees || []).some((a) => a.memberRef === memberRef);
  const kindOf = (c) => (c.attendees.find((a) => a.memberRef === memberRef) || {});
  const upcoming = ((data && data.classes) || []).filter((c) => has(c) && endMsOf(c) > now).sort(byStart)
    .map((c) => ({ cls: c, kind: kindOf(c).kind, spot: kindOf(c).spot || '' }));
  const recent = ((data && data.recent) || []).filter(has).sort((a, b) => byStart(b, a))
    .map((c) => ({ cls: c, kind: 'booked', spot: '' }));
  return { upcoming, recent };
}
