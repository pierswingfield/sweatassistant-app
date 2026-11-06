// T-4 Team stats display models (PLAN-teams.md §5.3 item 6). Pure: the server's `stats`
// block in, display rows out. The server (server/team-stats.js, through the projection)
// already decided which classes may be counted and in which zone each one's day and hour
// fall; nothing here widens or re-derives that. Clocks and zones are inputs, and the
// viewer's calendar day comes from lib.js (dayKeyInZone), never a bare Date.

import { DateTime } from 'luxon';
import { dayKeyInZone } from '../lib.js';

export const WEEKDAY_SHORT = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
export const WEEKDAY_LONG = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
export const TIMES_MIN_START = 6;  // the busiest-times axis always shows at least 06:00..21:00
export const TIMES_MIN_END = 21;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const list = (v, n) => Array.from({ length: n }, (_, i) => num(Array.isArray(v) ? v[i] : 0));

/** The viewer's calendar day for an instant, in their zone (lib.js). */
export function viewerDayKey(now, zone) {
  return dayKeyInZone(DateTime.fromMillis(now, { zone: 'UTC' }).toISO(), zone);
}

/** "+3 on last week" / "-2 on last week" / "Same as last week" (owner: no bracketed total). */
export function weekChange(week) {
  const thisWeek = num(week && week.thisWeek);
  const delta = week && Number.isFinite(Number(week.delta)) ? Number(week.delta) : thisWeek - num(week && week.lastWeek);
  return { thisWeek, delta, tone: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same' };
}

/**
 * Team streak wording inputs. `since` is a yyyy-MM-dd class-zone day from the server;
 * it is compared with the viewer's own today (their zone) to say today / yesterday /
 * a weekday within the last week / a date.
 * @returns {{days: number, capped: boolean, since: null | {kind: 'today'|'yesterday'|'weekday'|'date', label: string}}}
 */
export function streakView(streak, { now, zone }) {
  const days = Math.max(0, Math.floor(num(streak && streak.days)));
  const capped = !!(streak && streak.capped) && days > 0;
  if (!days || !streak.since) return { days: 0, capped: false, since: null };
  const today = DateTime.fromISO(viewerDayKey(now, zone), { zone: 'UTC' });
  const since = DateTime.fromISO(String(streak.since), { zone: 'UTC' });
  if (!since.isValid || !today.isValid) return { days, capped, since: null };
  const back = Math.round(today.diff(since, 'days').days);
  let kind = 'date';
  if (back <= 0) kind = 'today';
  else if (back === 1 && days === 1) kind = 'yesterday';
  else if (back < 7) kind = 'weekday';
  const label = kind === 'weekday' ? WEEKDAY_SHORT[since.weekday - 1] : kind === 'date' ? since.toFormat('d LLL') : '';
  return { days, capped, since: { kind, label } };
}

function bars(counts) {
  const max = Math.max(0, ...counts);
  const peak = max > 0 && counts.filter((c) => c === max).length === 1 ? counts.indexOf(max) : -1;
  return { max, peak, total: counts.reduce((a, b) => a + b, 0), frac: (c) => (max ? c / max : 0) };
}

/** Busiest days, Monday first. `peak` is the single busiest day, or -1 on a tie or no data. */
export function busiestDaysView(counts) {
  const c = list(counts, 7);
  const b = bars(c);
  return {
    total: b.total,
    peak: b.peak,
    peakName: b.peak >= 0 ? WEEKDAY_LONG[b.peak] : null,
    bars: c.map((count, i) => ({ label: WEEKDAY_SHORT[i], long: WEEKDAY_LONG[i], count, frac: b.frac(count), isPeak: i === b.peak })),
  };
}

const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/**
 * Busiest times by class-zone hour. The axis spans 06:00..21:00, widened to any hour
 * with classes; it is labelled every four hours and at its last hour (a regular
 * label closer than 3 h to the last one is dropped so the two never overlap).
 */
export function busiestTimesView(counts) {
  const c = list(counts, 24);
  const used = c.map((n, h) => (n > 0 ? h : -1)).filter((h) => h >= 0);
  const start = Math.min(TIMES_MIN_START, used.length ? used[0] : TIMES_MIN_START);
  const end = Math.max(TIMES_MIN_END, used.length ? used[used.length - 1] : TIMES_MIN_END);
  const slice = c.slice(start, end + 1);
  const b = bars(slice);
  return {
    total: b.total,
    peak: b.peak >= 0 ? start + b.peak : -1,
    bars: slice.map((count, i) => {
      const hour = start + i;
      // Every 4 h, dropping one that would crowd the final label.
      const tick = hour === end || (i % 4 === 0 && end - hour >= 3);
      return { hour, label: hh(hour), count, frac: b.frac(count), isPeak: i === b.peak, tick };
    }),
  };
}

/**
 * Gym mix: whole percentages that add up to 100 (largest remainder). The server sends
 * only gyms the viewer has linked; `brandOf(gymId)` supplies the name and colour.
 */
export function gymMixView(mix, brandOf = () => ({})) {
  const rows = (Array.isArray(mix) ? mix : []).filter((r) => r && r.gymId && num(r.count) > 0)
    .map((r) => ({ gymId: String(r.gymId), count: num(r.count) }));
  const total = rows.reduce((a, r) => a + r.count, 0);
  if (!total) return { total: 0, rows: [] };
  const raw = rows.map((r) => (r.count / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, rem: v - floors[i] })).sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
  for (const { i } of order) { if (left <= 0) break; floors[i] += 1; left -= 1; }
  return {
    total,
    rows: rows.map((r, i) => {
      const brand = brandOf(r.gymId) || {};
      return { ...r, percent: floors[i], frac: r.count / total, name: brand.name || '', colour: brand.colour || '' };
    }),
  };
}
