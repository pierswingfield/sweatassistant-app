// Sweat Assistant — C5-3: competing booking detection.
//
// Part 1: the pure detector (competing-bookings.js), including cross-gym time
// overlap and the naive-datetime zone rule. Part 2: over real HTTP against the
// dev mocks with a two-gym account — 409 on an exact duplicate, warnings (not
// blocks) on overlap, warnings on GET, and no leakage between users.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { detectCompetingBookings, detectQueueConflicts } = require('./competing-bookings');

const zoneOf = () => 'Europe/London';
const labelOf = (g) => ({ 'psycle-london': 'Psycle', 'jab-boxing': 'JAB' }[g] || g);
const opts = { zoneOf, labelOf };
const at = (iso, gymId, eventId, extra = {}) => ({ gymId, eventId, startAt: iso, durationMin: 45, className: 'C', ...extra });

function unit() {
  const A = at('2026-10-05T18:00:00.000Z', 'psycle-london', 1, { id: 1 });

  // (a) exact duplicate
  let w = detectCompetingBookings(at(A.startAt, 'psycle-london', 1), [A], [], opts);
  assert.deepStrictEqual(w.map(x => x.code), ['DUPLICATE_QUEUED']);
  assert.strictEqual(w[0].severity, 'error');
  // Same event id at a DIFFERENT gym is a different class (ids collide across gyms).
  w = detectCompetingBookings(at('2026-10-06T09:00:00.000Z', 'jab-boxing', 1), [A], [], opts);
  assert.deepStrictEqual(w, [], 'same provider id at another gym, another time: no warning');
  console.log('✅ Duplicate = same gym + event; provider-id collisions across gyms are not duplicates.');

  // (b) overlap, same gym and across gyms
  w = detectCompetingBookings(at('2026-10-05T18:30:00.000Z', 'psycle-london', 2), [A], [], opts);
  assert.deepStrictEqual(w.map(x => x.code), ['OVERLAP_QUEUED']);
  assert.strictEqual(w[0].severity, 'warning');
  assert.strictEqual(w[0].crossGym, false);
  w = detectCompetingBookings(at('2026-10-05T18:30:00.000Z', 'jab-boxing', 77), [A], [], opts);
  assert.deepStrictEqual(w.map(x => x.code), ['OVERLAP_QUEUED']);
  assert.strictEqual(w[0].crossGym, true, 'cross-gym overlap flagged as such');
  assert.match(w[0].message, /Psycle/, 'message names the other gym');
  console.log('✅ Overlap detected in one gym and across gyms.');

  // The reference carries display fields for a confirmation UI (U1-6), null when absent.
  const rich = detectCompetingBookings(at('2026-10-05T18:30:00.000Z', 'jab-boxing', 77), [{ ...A, groupName: 'RIDE', instructorName: 'Ana', instructorImageUrl: 'u', locationName: 'Soho', studioName: 'Ride Studio' }], [], opts);
  assert.deepStrictEqual(
    (({ groupName, instructorName, instructorImageUrl, locationName, studioName, durationMin }) => ({ groupName, instructorName, instructorImageUrl, locationName, studioName, durationMin }))(rich[0].with),
    { groupName: 'RIDE', instructorName: 'Ana', instructorImageUrl: 'u', locationName: 'Soho', studioName: 'Ride Studio', durationMin: 45 });
  assert.strictEqual(w[0].with.instructorImageUrl, null, 'absent display fields are null, not undefined');
  console.log('✅ Warning references carry display fields (null when the source never had them).');

  // Back-to-back and clear gaps are not overlaps; duration matters.
  w = detectCompetingBookings(at('2026-10-05T18:45:00.000Z', 'jab-boxing', 3), [A], [], opts);
  assert.deepStrictEqual(w, [], 'starts exactly when the other ends: no overlap');
  w = detectCompetingBookings(at('2026-10-05T18:45:00.000Z', 'jab-boxing', 3), [{ ...A, durationMin: 60 }], [], opts);
  assert.strictEqual(w.length, 1, 'a 60-minute class does overlap a 18:45 start');
  w = detectCompetingBookings(at('2026-10-05T18:30:00.000Z', 'jab-boxing', 3, { durationMin: undefined }), [{ ...A, durationMin: null }], [], opts);
  assert.strictEqual(w.length, 1, 'unknown durations fall back to a default rather than being skipped');
  console.log('✅ Back-to-back is not overlap; durations (and the default) are honoured.');

  // Naive datetimes are read in the ROW's gym zone (BST, UTC+1 in October).
  const naive = at('2026-10-05T19:00:00', 'psycle-london', 5); // 19:00 London = 18:00Z
  w = detectCompetingBookings(naive, [A], [], opts);
  assert.deepStrictEqual(w.map(x => x.code), ['OVERLAP_QUEUED'], 'naive 19:00 London overlaps 18:00Z');
  const zoned = { zoneOf: (g) => (g === 'far' ? 'America/New_York' : 'Europe/London'), labelOf };
  w = detectCompetingBookings(at('2026-10-05T14:00:00', 'far', 6), [A], [], zoned);
  assert.deepStrictEqual(w.map(x => x.code), ['OVERLAP_QUEUED'], 'naive 14:00 New York (EDT) = 18:00Z');
  console.log('✅ Naive datetimes are interpreted in each gym\'s own zone.');

  // (c) already booked / overlaps a booking
  const booked = [at(A.startAt, 'psycle-london', 1)];
  w = detectCompetingBookings(at(A.startAt, 'psycle-london', 1), [], booked, opts);
  assert.deepStrictEqual(w.map(x => x.code), ['ALREADY_BOOKED']);
  w = detectCompetingBookings(at('2026-10-05T18:15:00.000Z', 'jab-boxing', 9), [], booked, opts);
  assert.deepStrictEqual(w.map(x => x.code), ['OVERLAP_BOOKED']);
  console.log('✅ Already-booked and overlap-with-booking detected.');

  // Whole queue: both halves of a clash are flagged; bystanders are not; a bad date is ignored.
  const q = [
    { ...A },
    { ...at('2026-10-05T18:20:00.000Z', 'jab-boxing', 8, { id: 2 }) },
    { ...at('2026-10-09T07:00:00.000Z', 'psycle-london', 4, { id: 3 }) },
    { ...at('not-a-date', 'psycle-london', 10, { id: 4 }) },
  ];
  const by = detectQueueConflicts(q, [], opts);
  assert.deepStrictEqual(Object.keys(by).sort(), ['1', '2']);
  console.log('✅ Queue analysis flags both sides of a clash only.');
}

// ---------------------------------------------------------------- HTTP part
const PORT = 3097;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-competing.db');
const MOCK = path.join(__dirname, 'mock_bookings.dbjson');
const MOCK_BAK = `${MOCK}.competing-backup`;
const hadMock = fs.existsSync(MOCK);
if (hadMock) fs.copyFileSync(MOCK, MOCK_BAK);
let child;

function cleanup() {
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
  try { if (hadMock) { fs.copyFileSync(MOCK_BAK, MOCK); fs.unlinkSync(MOCK_BAK); } } catch (_) {}
}

async function http() {
  for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
  child = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(`[server:err] ${d}`));
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }

  const json = (r) => r.json();
  const post = (p, body, token) => fetch(`${BASE}${p}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const get = (p, token) => fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });

  const login = await json(await post('/api/auth/login', { email: 'dev@psycle.com', password: 'x' }));
  const token = login.token;
  const link = await post('/api/my-gyms/link', { gymId: 'jab-boxing', email: 'dev@jabboxing.mock', password: 'x' }, token);
  assert.strictEqual(link.status, 200, `link JAB failed: ${await link.text()}`);

  const day = new Date(Date.now() + 5 * 864e5); day.setUTCHours(18, 0, 0, 0);
  const t = (mins) => new Date(day.getTime() + mins * 60000).toISOString();
  const add = (body) => post('/api/auto-book', { studioId: null, className: 'Class', instructorName: '', studioName: '', locationName: '',
    preferences: { preferredSlots: [], preferredRows: [], requiredCount: 1 }, skipImmediate: true, ...body }, token);

  // The JAB mock models a rolling window (days 11-13 unreleased) so JAB's Auto-Book
  // path is reachable in dev; days 0-10 stay open for the suites that book them.
  {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10);
    const res = await fetch(`${BASE}/api/timetable?startDate=${from}&endDate=${to}`, { headers: { authorization: `Bearer ${token}`, 'x-gym-id': 'jab-boxing' } });
    const ev = await res.json();
    const list = ev.events || ev;
    const future = list.filter(e => e.releaseAt && Date.parse(e.releaseAt) > Date.now());
    assert.ok(future.length > 0, 'JAB mock has unreleased classes');
    assert.ok(future.every(e => Date.parse(e.startAt) - Date.parse(e.releaseAt) === 10 * 864e5), 'each opens exactly 10 days before it starts');
    const day10 = list.find(e => String(e.id) === '9100');
    assert.ok(day10 && Date.parse(day10.releaseAt) <= Date.now(), 'day-10 class 9100 stays released');
    console.log(`✅ JAB mock: ${future.length} unreleased classes (rolling 10-day window); day 0-10 classes stay open.`);
  }

  // First entry: clean.
  let r = await add({ eventId: 1000, gymId: 'psycle-london', startAt: t(0), durationMin: 45 });
  let b = await json(r);
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(b.warnings, []);
  const firstId = b.id;
  console.log('✅ First entry queues with no warnings.');

  // Exact duplicate: 409 with a code, and nothing was inserted.
  r = await add({ eventId: 1000, gymId: 'psycle-london', startAt: t(0), durationMin: 45 });
  b = await json(r);
  assert.strictEqual(r.status, 409); assert.strictEqual(b.code, 'DUPLICATE_AUTO_BOOK');
  assert.strictEqual((await json(await get('/api/auto-book', token))).length, 1, 'duplicate was not inserted');
  console.log('✅ Exact duplicate is rejected with 409 DUPLICATE_AUTO_BOOK.');

  // Cross-gym overlap WITHOUT confirmation (U1-6): refused with 409
  // OVERLAP_CONFIRM_REQUIRED and NOTHING inserted — the client shows the clash first.
  const overlapBody = { eventId: 9000, gymId: 'jab-boxing', startAt: t(20), durationMin: 45,
    className: 'Boxing Core', groupName: 'BOXING', instructorName: 'Sam', instructorImageUrl: 'https://img.example/sam.jpg',
    locationName: 'Shoreditch', studioName: 'Boxing Studio' };
  r = await add(overlapBody);
  b = await json(r);
  assert.strictEqual(r.status, 409, 'an unconfirmed overlap must not be committed');
  assert.strictEqual(b.code, 'OVERLAP_CONFIRM_REQUIRED');
  assert.strictEqual(b.warnings.length, 1);
  assert.strictEqual(b.warnings[0].code, 'OVERLAP_QUEUED');
  assert.strictEqual(b.warnings[0].crossGym, true);
  assert.match(b.message, /Overlaps another queued class/);
  assert.strictEqual((await json(await get('/api/auto-book?gymId=all', token))).length, 1, 'nothing was inserted');
  console.log('✅ Unconfirmed overlap is refused with 409 OVERLAP_CONFIRM_REQUIRED; nothing inserted.');

  // The warning carries what a UI needs to draw the OTHER class (its own row's data).
  const ref = b.warnings[0].with;
  assert.strictEqual(ref.gymId, 'psycle-london');
  assert.strictEqual(ref.source, 'queue');
  for (const k of ['className', 'startAt', 'durationMin', 'groupName', 'instructorName', 'instructorImageUrl', 'locationName', 'studioName']) {
    assert.ok(k in ref, `warning.with exposes ${k}`);
  }
  console.log('✅ The clashing class is described in warnings[].with (display fields present).');

  // Confirmed: accepted (200) WITH the warning, exactly as before C5-3's follow-up.
  r = await add({ ...overlapBody, confirmOverlap: true });
  b = await json(r);
  assert.strictEqual(r.status, 200, 'a confirmed overlap is queued');
  assert.strictEqual(b.warnings.length, 1);
  assert.strictEqual(b.warnings[0].code, 'OVERLAP_QUEUED');
  assert.strictEqual(b.warnings[0].crossGym, true);
  const secondId = b.id;
  console.log('✅ With confirmOverlap:true the overlap is queued, with the OVERLAP_QUEUED warning.');

  // A duplicate is never confirmable: still a hard 409, flag or not.
  r = await add({ eventId: 1000, gymId: 'psycle-london', startAt: t(0), durationMin: 45, confirmOverlap: true });
  b = await json(r);
  assert.strictEqual(r.status, 409); assert.strictEqual(b.code, 'DUPLICATE_AUTO_BOOK');
  console.log('✅ confirmOverlap cannot override an exact duplicate.');

  // The display fields persisted on the queue row come back on the OTHER side's warning.
  let listNow = await json(await get('/api/auto-book', token));
  const firstRow = listNow.find(x => x.id === firstId);
  const jabRef = firstRow.warnings[0].with;
  assert.strictEqual(jabRef.instructorName, 'Sam');
  assert.strictEqual(jabRef.instructorImageUrl, 'https://img.example/sam.jpg');
  assert.strictEqual(jabRef.locationName, 'Shoreditch');
  console.log('✅ Stored instructor/photo/location travel on the clash reference.');

  // GET annotates both halves, and a per-gym filter still sees the cross-gym clash.
  let list = await json(await get('/api/auto-book', token));
  const byId = Object.fromEntries(list.map(x => [x.id, x]));
  assert.strictEqual(byId[firstId].warnings[0].code, 'OVERLAP_QUEUED');
  assert.strictEqual(byId[secondId].warnings[0].code, 'OVERLAP_QUEUED');
  list = await json(await get('/api/auto-book?gymId=jab-boxing', token));
  assert.strictEqual(list.length, 1); assert.strictEqual(list[0].warnings.length, 1);
  console.log('✅ GET annotates both halves; a per-gym view still shows the cross-gym clash.');

  // A separate class at a clear time is clean, and other users never see or trigger warnings.
  r = await add({ eventId: 1003, gymId: 'psycle-london', startAt: t(24 * 60), durationMin: 45 });
  assert.deepStrictEqual((await json(r)).warnings, []);
  const other = await json(await post('/api/auth/signup', { email: `other-${Date.now()}@test.local`, password: 'a-real-password' }));
  assert.deepStrictEqual(await json(await get('/api/auto-book?gymId=all', other.token)).catch(() => []), [], 'no leakage');
  console.log('✅ Non-conflicting entry is clean; other accounts are unaffected.');

  // Deleting one side clears the other's warning.
  await fetch(`${BASE}/api/auto-book/${secondId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  list = await json(await get('/api/auto-book', token));
  assert.deepStrictEqual(list.find(x => x.id === firstId).warnings, []);
  console.log('✅ Removing one side clears the warning on the other.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 C5-3: competing booking detection\n');
  try {
    unit();
    await http();
    console.log('\n🎉 C5-3 COMPETING-BOOKING CHECK PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ C5-3 test FAILED:\n', err, '\n');
  } finally {
    cleanup();
  }
  process.exit(failed);
})();
