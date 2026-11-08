// T-4 unit tests for server/team-stats.js (PURE): week-on-week in each class's own zone,
// the same-moment comparison, Team streak edges, chart buckets in the class zone, and
// the chart/total share gates. No database. The privacy matrix for the same fields, on
// a real database through teams.js, is in test-team-privacy.js.

const assert = require('assert');
const { DateTime } = require('luxon');
const { teamStats, STREAK_DAYS } = require('./team-stats');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const LON = 'Europe/London';
const NY = 'America/New_York';
const TOK = 'Asia/Tokyo';

// A completed class at a local wall time in its own zone.
const e = (local, zone = LON, over = {}) => ({
  gymId: 'psycle-london', zone, viewerLinked: true, activity: true, recent: true,
  startMs: DateTime.fromISO(local, { zone }).toMillis(), ...over,
});
const MON_10 = DateTime.fromISO('2026-11-09T10:00', { zone: LON }).toMillis(); // Monday, GMT

check('week: a class belongs to the week of its OWN zone\'s date, not the viewer\'s', () => {
  const s = teamStats({ now: MON_10, zone: LON, entries: [
    e('2026-11-08T23:30', LON),  // Sunday London: last week
    e('2026-11-08T20:00', NY),   // Sunday in New York (= Monday 01:00 London): still last week
    e('2026-11-09T08:00', TOK),  // Monday in Tokyo (= Sunday 23:00 London): this week
    e('2026-11-09T07:00', LON),  // Monday London: this week
  ] });
  assert.strictEqual(s.week.thisWeek, 2);
});

check('week: last week is compared up to the same moment, so Monday morning is not a fall', () => {
  const s = teamStats({ now: MON_10, zone: LON, entries: [
    e('2026-11-02T09:00'),       // last Monday before 10:00: counts
    e('2026-11-02T11:00'),       // last Monday after 10:00: not yet comparable
    e('2026-11-05T09:00'),       // last Thursday: later in the week than "now"
    e('2026-11-09T07:00'),
  ] });
  assert.deepStrictEqual(s.week, { thisWeek: 1, lastWeek: 1, delta: 0 });
  const later = teamStats({ now: DateTime.fromISO('2026-11-12T20:00', { zone: LON }).toMillis(), zone: LON, entries: [
    e('2026-11-02T09:00'), e('2026-11-02T11:00'), e('2026-11-05T09:00'),
    e('2026-11-09T07:00'), e('2026-11-10T07:00'), e('2026-11-11T07:00'), e('2026-11-12T07:00'),
  ] });
  assert.deepStrictEqual(later.week, { thisWeek: 4, lastWeek: 3, delta: 1 });
});

check('week: the viewer\'s zone sets Monday; activity-off entries never count', () => {
  // 2026-11-09 03:00 UTC is still Sunday in New York: the viewer's week has not turned.
  const now = Date.parse('2026-11-09T03:00:00Z');
  const s = teamStats({ now, zone: NY, entries: [e('2026-11-08T18:00', NY), e('2026-11-08T19:00', NY, { activity: false })] });
  assert.strictEqual(s.week.thisWeek, 1, 'Sunday is the end of the NY viewer\'s current week');
  assert.strictEqual(teamStats({ now, zone: LON, entries: [e('2026-11-08T18:00', NY)] }).week.thisWeek, 0, 'a London viewer is already in the next week');
});

check('streak: today without a class yet does not break it; a gap does', () => {
  const run = [e('2026-11-06T08:00'), e('2026-11-07T08:00'), e('2026-11-08T08:00')];
  const s = teamStats({ now: MON_10, zone: LON, entries: run });
  assert.deepStrictEqual(s.streak, { days: 3, since: '2026-11-06', capped: false });
  const withToday = teamStats({ now: MON_10, zone: LON, entries: [...run, e('2026-11-09T07:00')] });
  assert.deepStrictEqual(withToday.streak, { days: 4, since: '2026-11-06', capped: false });
  const gap = teamStats({ now: MON_10, zone: LON, entries: [e('2026-11-06T08:00'), e('2026-11-08T08:00')] });
  assert.deepStrictEqual(gap.streak, { days: 1, since: '2026-11-08', capped: false });
  const broken = teamStats({ now: MON_10, zone: LON, entries: [e('2026-11-07T08:00')] });
  assert.deepStrictEqual(broken.streak, { days: 0, since: null, capped: false }, 'nothing yesterday or today');
  assert.deepStrictEqual(teamStats({ now: MON_10, zone: LON, entries: [] }).streak, { days: 0, since: null, capped: false });
});

check('week: "same moment last week" is calendar time across a DST change, not 7 x 24 h', () => {
  // Wed 28 Oct 2026 10:00 GMT; the same moment last week is Wed 21 Oct 10:00 BST (09:00 UTC).
  // 10:30 BST on the 21st is AFTER it, though it is before now minus 168 hours (11:00 BST).
  const now = DateTime.fromISO('2026-10-28T10:00', { zone: LON }).toMillis();
  const s = teamStats({ now, zone: LON, entries: [e('2026-10-21T10:30'), e('2026-10-21T09:30')] });
  assert.strictEqual(s.week.lastWeek, 1);
});

check('streak: an unlinked-gym day never extends the run (T-4 review: no per-day inference)', () => {
  const s = teamStats({ now: MON_10, zone: LON, entries: [
    e('2026-11-08T08:00'),
    e('2026-11-07T08:00', LON, { viewerLinked: false, gymId: 'x' }),
    e('2026-11-06T08:00'),
  ] });
  assert.deepStrictEqual(s.streak, { days: 1, since: '2026-11-08', capped: false });
});

check('streak: each class counts on its own zone\'s day', () => {
  // 23:30 Sunday in New York is Monday 04:30 London; it fills SUNDAY, so with Saturday the run is 2.
  const s = teamStats({ now: MON_10, zone: LON, entries: [e('2026-11-07T09:00'), e('2026-11-08T23:30', NY)] });
  assert.deepStrictEqual(s.streak, { days: 2, since: '2026-11-07', capped: false });
});

check('streak: needs both activity and recent; a run reaching the loaded window is capped', () => {
  const s = teamStats({ now: MON_10, zone: LON, entries: [e('2026-11-08T08:00', LON, { recent: false }), e('2026-11-07T08:00', LON, { activity: false })] });
  assert.strictEqual(s.streak.days, 0);
  const long = [];
  for (let d = 0; d <= STREAK_DAYS + 3; d++) long.push(e(DateTime.fromMillis(MON_10, { zone: LON }).minus({ days: d }).set({ hour: 7 }).toISO({ includeOffset: false })));
  const c = teamStats({ now: MON_10, zone: LON, entries: long });
  assert.strictEqual(c.streak.capped, true);
  assert.ok(c.streak.days >= STREAK_DAYS && c.streak.days <= STREAK_DAYS + 1, String(c.streak.days));
});

check('charts: days and hours in the class zone; only recent ∧ viewer-linked ∧ last 28 days', () => {
  const s = teamStats({ now: MON_10, zone: LON, entries: [
    e('2026-11-07T07:00', NY, { gymId: 'jab-boxing' }),             // Saturday 07:00 NY
    e('2026-11-08T08:30'),                                           // Sunday 08:30
    e('2026-11-08T08:45'),
    e('2026-11-07T09:00', LON, { viewerLinked: false, gymId: 'x' }), // unlinked gym: excluded
    e('2026-11-06T09:00', LON, { recent: false }),                   // recent off: excluded
    e('2026-10-01T09:00'),                                           // outside 28 days
  ] });
  assert.strictEqual(s.charts.total, 3);
  assert.deepStrictEqual(s.charts.busiestDays, [0, 0, 0, 0, 0, 1, 2]);
  assert.strictEqual(s.charts.busiestTimes[7], 1, 'the NY class is a 07:00 class');
  assert.strictEqual(s.charts.busiestTimes[8], 2);
  assert.strictEqual(s.charts.busiestTimes.reduce((a, b) => a + b, 0), 3);
  assert.deepStrictEqual(s.charts.gymMix, [{ gymId: 'psycle-london', count: 2 }, { gymId: 'jab-boxing', count: 1 }]);
  assert.ok(!JSON.stringify(s).includes('"x"'), 'an unlinked gym id is never in the output');
});

check('future entries are ignored', () => {
  const s = teamStats({ now: MON_10, zone: LON, entries: [e('2026-11-09T18:00')] });
  assert.deepStrictEqual([s.week.thisWeek, s.streak.days, s.charts.total], [0, 0, 0]);
});

check('trending instructors: equal 14-day windows, positive growth, minimum visits and gym-qualified names', () => {
  const row = (days, name, extra = {}) => e(DateTime.fromMillis(MON_10 - days * 24 * 3600e3).toISO(), LON, { instructorId: name, instructorName: name, ...extra });
  const entries = [row(1, 'Kemi'), row(2, 'Kemi'), row(3, 'Kemi'), row(15, 'Kemi'), row(28, 'Kemi'),
    row(1, 'Sam'), row(15, 'Sam'), row(16, 'Sam'), // falling: omitted
    row(1, 'Single'), // insufficient data
    row(1, 'Kemi', { gymId: 'jab-boxing' }), row(2, 'Kemi', { gymId: 'jab-boxing' }),
    row(1, 'Private', { recent: false }), row(2, 'Private', { recent: false }),
    row(1, 'Hidden gym', { viewerLinked: false }), row(2, 'Hidden gym', { viewerLinked: false }),
    row(-1, 'Future'), row(-2, 'Future'), row(29, 'Too old')];
  const result = teamStats({ now: MON_10, zone: LON, entries }).charts.trendingInstructors;
  assert.deepStrictEqual(result.map(({ gymId, name, current, previous, delta }) => ({ gymId, name, current, previous, delta })), [
    { gymId: 'jab-boxing', name: 'Kemi', current: 2, previous: 0, delta: 2 },
    { gymId: 'psycle-london', name: 'Kemi', current: 3, previous: 2, delta: 1 },
  ]);
  assert.deepStrictEqual(teamStats({ now: MON_10, entries: [] }).charts.trendingInstructors, []);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); } catch (err) { failed++; console.error(`  ✗ ${c.name}\n    ${err && err.stack}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
