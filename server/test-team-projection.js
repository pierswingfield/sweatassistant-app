// T-2 unit tests for the PURE Team modules: team-mascot.js (state machine, daily pose
// rotation, eligibility, ring) and team-projection.js (rows in, payload out: today line
// inputs, hottest, solo, next-class hint, zones at midnight). No database.

const assert = require('assert');
const mascot = require('./team-mascot');
const { projectTeam } = require('./team-projection');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const H = 3600e3;
const cls = (startIso, { dur = 45, discipline = '', className = '' } = {}) => {
  const startMs = Date.parse(startIso);
  return { startMs, endMs: mascot.endMsOf(startMs, dur), discipline, className };
};
const LON = 'Europe/London';

// --- mascot ----------------------------------------------------------------------

check('states: resting, warming, exercising, cooling, champion, sleeping', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const m = (classes, at = now) => mascot.mascotFor({ teamId: 't1', classes, now: at, zone: LON }).state;
  assert.strictEqual(m([]), 'resting');
  assert.strictEqual(m([cls('2026-11-10T15:00:00Z')]), 'warming');
  assert.strictEqual(m([cls('2026-11-10T11:30:00Z')]), 'exercising');
  assert.strictEqual(m([cls('2026-11-10T08:00:00Z'), cls('2026-11-10T15:00:00Z')]), 'cooling');
  assert.strictEqual(m([cls('2026-11-10T08:00:00Z')]), 'champion');
  assert.strictEqual(m([], Date.parse('2026-11-10T04:59:00Z')), 'sleeping');
  assert.strictEqual(m([cls('2026-11-10T08:00:00Z')], Date.parse('2026-11-10T22:00:00Z')), 'sleeping');
  // In class at 22:30: exercising beats sleeping (nothing in progress is the condition).
  assert.strictEqual(m([cls('2026-11-10T22:15:00Z')], Date.parse('2026-11-10T22:30:00Z')), 'exercising');
  // Night is the VIEWER's: 23:00 in New York is 04:00 London.
  assert.strictEqual(mascot.mascotFor({ teamId: 't', classes: [], now: Date.parse('2026-11-11T02:00:00Z'), zone: 'America/New_York' }).state, 'resting');
});

check('night waits for unfinished Eastern classes, including the midnight and DST boundary', () => {
  const state = (now, classes) => mascot.mascotFor({ teamId: 't', now: Date.parse(now), zone: LON, classes }).state;
  const eastern = cls('2026-11-10T19:30:00-05:00');
  assert.strictEqual(state('2026-11-10T22:30:00Z', [eastern]), 'warming');
  assert.strictEqual(state('2026-11-11T00:45:00Z', [eastern]), 'exercising');
  assert.strictEqual(state('2026-11-11T01:15:00Z', [eastern]), 'sleeping');
  const dst = cls('2026-11-01T01:30:00-05:00');
  assert.strictEqual(state('2026-11-01T04:30:00Z', [dst]), 'warming');
});

check('ring = progress through ALL the day\'s classes (a class in progress counts its elapsed share); cooling down renders smaller (fit)', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const r = mascot.mascotFor({ teamId: 't', now, zone: LON,
    classes: [cls('2026-11-10T07:00:00Z'), cls('2026-11-10T08:00:00Z'), cls('2026-11-10T11:50:00Z'), cls('2026-11-10T18:00:00Z')] });
  assert.strictEqual(r.state, 'exercising');
  // Two done (2) + 11:50 class 10 of 45 min in (0.222) + one to come (0), over 4 (T-4).
  assert.strictEqual(r.ring, 0.556);
  const c = mascot.mascotFor({ teamId: 't', now, zone: LON, classes: [cls('2026-11-10T07:00:00Z'), cls('2026-11-10T18:00:00Z'), cls('2026-11-10T19:00:00Z')] });
  assert.strictEqual(c.state, 'cooling');
  assert.strictEqual(c.fit, true);
  assert.strictEqual(c.ring, 0.333);
  assert.strictEqual(mascot.mascotFor({ teamId: 't', now, zone: LON, classes: [] }).ring, 0);
});

check('exercising pose: deterministic per Team and date, rotates across dates and Teams', () => {
  const a1 = mascot.exercisingPose('team-A', '2026-11-10', []);
  const a2 = mascot.exercisingPose('team-A', '2026-11-10', []);
  assert.strictEqual(a1.id, a2.id);
  const days = new Set();
  for (let d = 1; d <= 28; d++) days.add(mascot.exercisingPose('team-A', `2026-11-${String(d).padStart(2, '0')}`, []).id);
  assert.ok(days.size >= 3, `rotation should vary over a month, got ${[...days]}`);
  const teamsSeen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((t) => mascot.exercisingPose(t, '2026-11-10', []).id));
  assert.ok(teamsSeen.size >= 2);
});

check('eligibility: bike only with a cycle/ride class, boxing only with a boxing class', () => {
  const seen = (classes) => {
    const s = new Set();
    for (let d = 1; d <= 60; d++) s.add(mascot.exercisingPose('team-X', `2026-${d <= 30 ? '11' : '12'}-${String(((d - 1) % 30) + 1).padStart(2, '0')}`, classes).id);
    return s;
  };
  const plain = seen([{ discipline: 'Strength', className: 'Train' }]);
  assert.ok(!plain.has('bike') && !plain.has('boxing'));
  const ride = seen([{ discipline: 'Ride', className: 'Ride 45' }]);
  assert.ok(ride.has('bike') && !ride.has('boxing'));
  const box = seen([{ discipline: 'Boxing', className: 'Boxing Fundamentals' }]);
  assert.ok(box.has('boxing') && !box.has('bike'));
  assert.ok(!mascot.isCycle({ className: 'Bridge' }), 'no false positive on "ride" inside a word');
});

check('pose fallback: dumbbell when no registry entry is eligible; every asset is a team- webp', () => {
  const never = mascot.REGISTRY.map((p) => ({ ...p, eligible: () => false }));
  assert.strictEqual(mascot.exercisingPose('t', '2026-11-10', [], never).id, 'dumbbell');
  const throwing = mascot.REGISTRY.map((p) => ({ ...p, eligible: () => { throw new Error('bad rule'); } }));
  assert.strictEqual(mascot.exercisingPose('t', '2026-11-10', null, throwing).id, 'dumbbell');
  for (const p of mascot.REGISTRY) assert.match(p.asset, /^\/characters\/team-[a-z]+\.webp$/);
  for (const a of Object.values(mascot.STATE_ART)) assert.match(a.asset, /^\/characters\/team-[a-z]+\.webp$/);
  assert.strictEqual(mascot.FALLBACK_POSE, 'dumbbell');
});

check('pose date is the VIEWER\'s local date at midnight', () => {
  // 23:30 UTC on 10 Nov is 18:30 on 10 Nov in New York but already 11 Nov in Tokyo.
  const now = Date.parse('2026-11-10T23:30:00Z');
  const classes = [cls('2026-11-10T23:15:00Z')];
  const ny = mascot.mascotFor({ teamId: 'mid', classes, now, zone: 'America/New_York' });
  const tk = mascot.mascotFor({ teamId: 'mid', classes, now, zone: 'Asia/Tokyo' });
  assert.strictEqual(ny.pose, mascot.exercisingPose('mid', '2026-11-10', classes).id);
  assert.strictEqual(tk.pose, mascot.exercisingPose('mid', '2026-11-11', classes).id);
});

// --- projection ------------------------------------------------------------------

const share = (over = {}) => ({ gyms: 'all', upcoming: true, waitlists: true, activity: true, recent: true, spots: false, autoBookQueue: false, ...over });
const member = (userId, name, rows = {}, over = {}) => ({
  userId, memberRef: `ref-${name}`, name, colourIndex: userId, isCaptain: false, share: share(over.share), pausedUntil: over.pausedUntil || null,
  links: rows.links || [{ gym_id: 'g1', account_enabled: 1 }, { gym_id: 'ny', account_enabled: 1 }],
  bookings: rows.bookings || [], waitlists: rows.waitlists || [], queue: rows.queue || [], history: rows.history || [], syncState: rows.syncState || [],
});
const bk = (gym, id, event, start, name, extra = {}) => ({ gym_id: gym, booking_id: id, event_id: event, start_at: start, class_name: name, origin: 'server', duration_min: 45, ...extra });
const zoneOf = (g) => (g === 'ny' ? 'America/New_York' : LON);
const run = (members, now, extra = {}) => projectTeam({ viewer: { userId: 1, linkedGymIds: ['g1', 'ny'] }, team: { id: 'T' }, members, now, zone: LON, zoneOf, ...extra });

check('today line inputs: total, done, first upcoming time; hottest needs two people', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const p = run([
    member(1, 'Ana', { bookings: [bk('g1', 1, 10, '2026-11-10T07:00:00Z', 'Ride 45'), bk('g1', 2, 11, '2026-11-10T12:15:00Z', 'Train')] }),
    member(2, 'Ben', { bookings: [bk('g1', 3, 11, '2026-11-10T12:15:00Z', 'Train')] }),
  ], now);
  assert.strictEqual(p.today.total, 2);
  assert.strictEqual(p.today.done, 1);
  assert.strictEqual(p.today.firstAt.startAt, '2026-11-10T12:15:00.000+00:00');
  assert.strictEqual(p.today.hottest.count, 2);
  assert.strictEqual(p.today.hottest.key, 'g1:11');
  assert.strictEqual(p.today.solo, null);
  assert.deepStrictEqual(p.today.activeToday.sort(), ['ref-Ana', 'ref-Ben']);
  assert.strictEqual(p.mascot.state, 'cooling');
});

check('T9 upNext: soonest not-started class, any day, with no names or counts', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const p = run([
    member(1, 'John', { bookings: [bk('g1', 1, 10, '2026-11-10T08:30:00Z', 'Early'), bk('g1', 2, 12, '2026-11-12T08:30:00Z', 'Later'), bk('g1', 3, 11, '2026-11-10T18:30:00Z', 'Train')] }),
    member(2, 'Kim'),
  ], now);
  assert.strictEqual(p.today.upNext.className, 'Train');
  assert.strictEqual(p.today.upNext.gymId, 'g1');
  assert.deepStrictEqual(Object.keys(p.today.upNext).sort(), ['className', 'gymId', 'key', 'locationName', 'startAt', 'timeZone']);
  assert.strictEqual(run([member(1, 'John', { bookings: [bk('g1', 1, 10, '2026-11-10T08:30:00Z', 'Early')] })], now).today.upNext, null);
});

check('solo line when one person is doing the next class; next-class hint when today is over', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const p = run([member(1, 'John', { bookings: [bk('g1', 1, 10, '2026-11-10T08:30:00Z', 'Early'), bk('g1', 2, 11, '2026-11-10T18:30:00Z', 'Train')] }), member(2, 'Kim')], now);
  assert.strictEqual(p.today.solo.name, 'John');
  assert.strictEqual(p.today.solo.className, 'Train');
  assert.strictEqual(p.today.next, null);
  const later = run([member(1, 'John', { bookings: [bk('g1', 1, 10, '2026-11-10T08:30:00Z', 'Early'), bk('g1', 2, 12, '2026-11-11T08:30:00Z', 'Train')] }), member(2, 'Kim')], now);
  assert.strictEqual(later.mascot.state, 'champion');
  assert.deepStrictEqual([later.today.next.when, later.today.next.name, later.today.next.count], ['tomorrow', 'John', 1]);
  const rest = run([member(1, 'John', { bookings: [bk('g1', 2, 12, '2026-11-13T08:30:00Z', 'Fri')] }), member(2, 'Kim')], now);
  assert.strictEqual(rest.today.total, 0);
  assert.strictEqual(rest.mascot.state, 'resting');
  assert.strictEqual(rest.today.next.when, 'later');
});

check('"today" is each class\'s own zone: a New York 21:00 class is today there, tomorrow in London', () => {
  // 10 Nov 23:30 London = 18:30 New York. A NY class at 21:00 local (02:00Z 11 Nov) is
  // still 10 Nov in its own zone, so it is part of the Team's day.
  const now = Date.parse('2026-11-10T23:30:00Z');
  const p = run([member(1, 'Ana', { bookings: [bk('ny', 1, 10, '2026-11-10T21:00:00-05:00', 'NY Late')] }), member(2, 'Ben')], now);
  assert.strictEqual(p.today.total, 1);
  assert.strictEqual(p.classes[0].timeZone, 'America/New_York');
  assert.strictEqual(p.classes[0].startAt, '2026-11-10T21:00:00.000-05:00');
  // A London class at 00:15 on 11 Nov is NOT today for the London gym at 23:30 on 10 Nov.
  const q = run([member(1, 'Ana', { bookings: [bk('g1', 1, 10, '2026-11-11T00:15:00Z', 'Midnight')] }), member(2, 'Ben')], now);
  assert.strictEqual(q.today.total, 0);
  assert.strictEqual(q.today.next.when, 'tomorrow');
});

check('projection is pure input -> output and refuses a viewer who is not a member', () => {
  assert.throws(() => projectTeam({ viewer: { userId: 99, linkedGymIds: [] }, team: { id: 'T' }, members: [member(1, 'A')], now: 0, zone: LON, zoneOf }));
  const src = require('fs').readFileSync(require('path').join(__dirname, 'team-projection.js'), 'utf8');
  assert.ok(!/require\('\.\/db'\)|fetch\(|getProvider/.test(src), 'no db, network or provider in the projection');
});

check('multi-slot booking: one attendee with joined spots; booked beats waitlist and queue', () => {
  const now = Date.parse('2026-11-10T10:00:00Z');
  const p = run([member(1, 'Ana', {
    bookings: [bk('g1', 1, 10, '2026-11-10T12:00:00Z', 'Ride', { slot_label: '4' }), bk('g1', 2, 10, '2026-11-10T12:00:00Z', 'Ride', { slot_label: '5' })],
    waitlists: [{ gym_id: 'g1', event_id: 10, start_at: '2026-11-10T12:00:00Z', class_name: 'Ride' }],
  }, { share: { spots: true } }), member(2, 'Ben')], now);
  assert.deepStrictEqual(p.classes[0].attendees, [{ memberRef: 'ref-Ana', kind: 'booked', spot: '4, 5' }]);
});

(async () => {
  let failed = 0;
  for (const c of checks) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); } catch (err) { failed++; console.error(`  ✗ ${c.name}\n    ${err && err.stack}`); }
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  process.exit(failed ? 1 : 0);
})();
