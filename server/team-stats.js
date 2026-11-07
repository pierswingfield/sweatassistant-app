// T-4 Team stats (PLAN-teams.md §5.3 item 6). PURE: entries in, aggregates out. No db,
// no network; the clock and zones are inputs. server/team-projection.js decides which
// classes may be entries at all (§7.3: member, not paused, gym shared and enabled,
// server-synced, not cancelled or penalised, `missing_since` confirmed) and tags each
// with what its sharer allowed; this module only counts.
//
// Each stat reads only the entries its sharing category covers:
//   week   (classes this week, "+3 on last week")  -> `activity`; every shared gym,
//          including gyms the viewer hasn't linked (D2: counted in totals, never named)
//   streak (Team streak)                            -> `activity` AND `recent` (it is
//          day-level history, which only "Recent classes" consents to) AND a gym the VIEWER
//          has linked. Not every shared gym: in a small Team the viewer can subtract their
//          own days and the itemised Recent list from the run, and an unlinked-gym day would
//          then show that one named member trained at that gym on that date, which D2's
//          consent copy ("still see that you trained, not the details") does not cover and
//          §8.1 reserves for an explicit opt-in (T-4 review).
//   busiestDays, busiestTimes, gymMix (the charts)  -> `recent` AND a gym the VIEWER has
//          linked, inside the recent window. The charts therefore never reveal more than
//          the itemised "Recent classes" list already shows this viewer, so no small-Team
//          subtraction can recover anything a member kept private, and an unlinked gym
//          never moves the gym mix or appears in it.
//
// Days and hours are read in each CLASS's own zone ("counting each class in its own
// zone", §5.3): an 08:30 class is a morning class wherever the viewer is. The viewer's
// zone only anchors "today" and the week (Monday start).

const { DateTime } = require('luxon');

const DAY_MS = 24 * 3600 * 1000;
const CHART_DAYS = 28;     // "Last 4 weeks" (inside the 30-day recent window)
const STREAK_DAYS = 30;    // the history the projection loads; a longer streak reads "30+"

/**
 * @param {object} p
 * @param {{gymId: string, startMs: number, zone: string, viewerLinked: boolean,
 *          activity: boolean, recent: boolean}[]} p.entries  completed classes, one per
 *          (member, gym-qualified booking id); already privacy-filtered by the projection
 * @param {number} p.now   epoch ms
 * @param {string} p.zone  the viewer's IANA zone
 */
function teamStats({ entries = [], now, zone = 'UTC' }) {
  const local = DateTime.fromMillis(now, { zone });
  const todayKey = local.toISODate();
  const weekStartKey = local.startOf('week').toISODate();
  const lastWeekStartKey = local.startOf('week').minus({ weeks: 1 }).toISODate();
  // Calendar arithmetic, not 7 x 24 h: across a DST change the two differ by an hour.
  const sameMomentLastWeek = local.minus({ weeks: 1 }).toMillis();

  const done = entries
    .filter((e) => e && Number.isFinite(e.startMs) && e.startMs <= now)
    .map((e) => {
      const dt = DateTime.fromMillis(e.startMs, { zone: e.zone || 'UTC' });
      return { ...e, dt: dt.isValid ? dt : DateTime.fromMillis(e.startMs, { zone: 'UTC' }) };
    })
    .map((e) => ({ ...e, dayKey: e.dt.toISODate() }));

  // Classes this week vs last week UP TO THE SAME MOMENT, so Monday morning reads "same
  // as last week", not "-14 on last week".
  const act = done.filter((e) => e.activity);
  const thisWeek = act.filter((e) => e.dayKey >= weekStartKey && e.dayKey <= todayKey).length;
  const lastWeek = act.filter((e) => e.dayKey >= lastWeekStartKey && e.dayKey < weekStartKey && e.startMs <= sameMomentLastWeek).length;

  // Team streak: consecutive days with at least one completed class. Today without a
  // class yet does not break it (the day isn't over): the run then counts from yesterday.
  const streakDays = new Set(done.filter((e) => e.activity && e.recent && e.viewerLinked && e.startMs >= now - STREAK_DAYS * DAY_MS).map((e) => e.dayKey));
  let cursor = local.startOf('day');
  if (!streakDays.has(todayKey)) cursor = cursor.minus({ days: 1 });
  let days = 0;
  let since = null;
  while (streakDays.has(cursor.toISODate())) {
    days += 1;
    since = cursor.toISODate();
    cursor = cursor.minus({ days: 1 });
  }
  const windowStartKey = DateTime.fromMillis(now - STREAK_DAYS * DAY_MS, { zone }).toISODate();
  // The run reaches the edge of the loaded history: the day before it may hold a class
  // we never loaded, so it reads "30+ days" rather than claiming an exact start.
  const capped = days > 0 && DateTime.fromISO(since, { zone }).minus({ days: 1 }).toISODate() <= windowStartKey;

  // Charts: itemised-visible classes only (see the header).
  const charted = done.filter((e) => e.recent && e.viewerLinked && e.startMs >= now - CHART_DAYS * DAY_MS);
  const busiestDays = [0, 0, 0, 0, 0, 0, 0];       // Monday .. Sunday
  const busiestTimes = new Array(24).fill(0);      // hour of day, class zone
  const mix = new Map();
  for (const e of charted) {
    busiestDays[e.dt.weekday - 1] += 1;
    busiestTimes[e.dt.hour] += 1;
    mix.set(e.gymId, (mix.get(e.gymId) || 0) + 1);
  }
  const gymMix = [...mix.entries()]
    .map(([gymId, count]) => ({ gymId, count }))
    .sort((a, b) => (b.count - a.count) || a.gymId.localeCompare(b.gymId));

  // Same itemised-visibility gate as the other charts. Compare equal rolling windows;
  // rank growth in shared class visits, never members or hidden-gym activity.
  const instructors = new Map();
  for (const e of charted) {
    const name = String(e.instructorName || '').trim();
    if (!name) continue;
    const key = `${e.gymId}:${name.toLocaleLowerCase('en')}`;
    if (!instructors.has(key)) instructors.set(key, { gymId: e.gymId, instructorId: e.instructorId || null, name, current: 0, previous: 0 });
    const row = instructors.get(key);
    if (e.instructorId) row.instructorId = e.instructorId;
    row[e.startMs >= now - 14 * DAY_MS ? 'current' : 'previous'] += 1;
  }
  const trendingInstructors = [...instructors.values()]
    .map((r) => ({ ...r, delta: r.current - r.previous }))
    .filter((r) => r.current >= 2 && r.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.current - a.current || a.gymId.localeCompare(b.gymId) || a.name.localeCompare(b.name))
    .slice(0, 3);

  return {
    week: { thisWeek, lastWeek, delta: thisWeek - lastWeek },
    streak: { days, since: days ? since : null, capped },
    charts: { windowDays: CHART_DAYS, total: charted.length, busiestDays, busiestTimes, gymMix, trendingInstructors },
  };
}

module.exports = { teamStats, CHART_DAYS, STREAK_DAYS };
