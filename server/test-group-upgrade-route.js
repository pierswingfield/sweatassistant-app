// Group Auto-Upgrade over HTTP: POST /api/auto-upgrade accepts a group of own reservations
// (one monitor, members listed on GET), refuses a guest member server-side, and rejects a
// duplicate group. Mock dev account only.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const PORT = 3086;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(__dirname, 'test-groupupgrade.db');
let child;
const MOCK_BOOKINGS = path.join(__dirname, 'test-groupupgrade-bookings.json');
const mkBooking = (id, eventId, slot) => ({ id, event_id: eventId, booked_at: new Date().toISOString(), studio_slot: { id: slot, label: String(slot) },
  event: { id: eventId, name: 'Ride 45', start_at: new Date(Date.now() + 2 * 864e5).toISOString(), event_type: { id: 20, name: 'RIDE: Ride 45', group: { id: 1, name: 'Ride' } },
    instructor: { id: 10, name: 'ADAM', full_name: 'Adam' }, studio: { id: 138, name: 'Ride Studio', location: { id: 13, name: 'Mortimer Street' } } } });
const cleanup = () => {
  try { fs.unlinkSync(MOCK_BOOKINGS); } catch (_) {}
  try { child && child.kill(); } catch (_) {}
  for (const f of [DB_PATH, `${DB_PATH}-journal`, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
};

async function run() {
  cleanup();
  fs.writeFileSync(MOCK_BOOKINGS, JSON.stringify([
    mkBooking(9101, 1000, 25), mkBooking(9102, 1000, 26), mkBooking(9103, 1000, 27),
    mkBooking(9201, 1000, 31), mkBooking(9202, 1000, 32), mkBooking(9301, 1000, 41), mkBooking(9302, 1000, 42),
    mkBooking(9401, 1000, 51), mkBooking(9999, 1003, 11),
  ]));
  child = spawn('node', ['server.js'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MOCK_BOOKINGS_PATH: MOCK_BOOKINGS, PORT: String(PORT), DB_PATH, NODE_ENV: 'development', JWT_SECRET: 't',
      ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ADMIN_PASSWORD: 'x' } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/config`)).ok) break; } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const H = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}`, 'x-gym-id': 'psycle-london' });
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: H(''),
    body: JSON.stringify({ email: 'dev@psycle.com', password: 'x' }) })).json();
  const t = login.token;
  const startAt = new Date(Date.now() + 2 * 864e5).toISOString();
  const body = (members, extra = {}) => JSON.stringify({
    eventId: 1000, studioId: 138, bookingId: members[0].bookingId, currentSlotId: members[0].slotId,
    className: 'Ride 45', instructorName: 'I', studioName: 'S', locationName: 'L', startAt,
    preferences: { keepOriginalOnCutoff: false, prioritizeTogether: true }, groupName: 'RIDE', gymId: 'psycle-london', members, ...extra,
  });
  const post = (b) => fetch(`${BASE}/api/auto-upgrade`, { method: 'POST', headers: H(t), body: b });

  const group = [{ bookingId: 9101, slotId: 25 }, { bookingId: 9102, slotId: 26 }];
  const ok = await post(body(group));
  assert.strictEqual(ok.status, 200, 'group monitor accepted');
  const dup = await post(body([{ bookingId: 9102, slotId: 26 }, { bookingId: 9103, slotId: 27 }]));
  assert.strictEqual(dup.status, 409, 'a booking already in a live group cannot start another monitor');
  assert.strictEqual((await dup.json()).code, 'DUPLICATE_AUTO_UPGRADE');
  // Ownership: ids the user does not hold on THIS event are refused (selection only).
  const foreign = await post(body([{ bookingId: 9401, slotId: 51 }, { bookingId: 424242, slotId: 52 }]));
  assert.strictEqual(foreign.status, 400, 'an unknown booking id is refused');
  assert.strictEqual((await foreign.json()).code, 'MEMBER_NOT_FOUND');
  const otherEvent = await post(body([{ bookingId: 9401, slotId: 51 }, { bookingId: 9999, slotId: 11 }]));
  assert.strictEqual(otherEvent.status, 400, 'a booking on another event is refused');
  // A 409 must change nothing: single monitor on 9401 survives a rejected duplicate group.
  const singleKeep = await post(body([{ bookingId: 9401, slotId: 51 }]).replace(/,"members":\[[^\]]*\]/, ''));
  assert.strictEqual(singleKeep.status, 200);
  const dupKeep = await post(body([{ bookingId: 9401, slotId: 51 }, { bookingId: 9102, slotId: 26 }]));
  assert.strictEqual(dupKeep.status, 409, 'overlaps the live group');
  const afterDup = await (await fetch(`${BASE}/api/auto-upgrade`, { headers: H(t) })).json();
  assert.ok(afterDup.some((u) => u.booking_id === 9401 && u.status === 'active'), 'single monitor untouched by a 409');
  const guest = await post(body([{ bookingId: 9201, slotId: 31 }, { bookingId: 9202, slotId: 32, isGuest: true }]));
  assert.strictEqual(guest.status, 400, 'a guest member is refused server-side');
  assert.strictEqual((await guest.json()).code, 'GUEST_GROUP_UNSUPPORTED');
  const list = (await (await fetch(`${BASE}/api/auto-upgrade`, { headers: H(t) })).json()).filter((u) => u.status === 'active' || (u.members || []).length);
  assert.strictEqual(list.filter((u) => (u.members || []).length > 1).length, 1, 'only the accepted group exists');
  const g0 = list.find((u) => (u.members || []).length > 1);
  assert.deepStrictEqual(g0.members.map((m) => m.booking_id).sort(), [9101, 9102], 'GET lists every member');
  assert.strictEqual(g0.preferences.prioritizeTogether, true, 'together flag carried');
  // A single-seat monitor already on one of the bookings is REPLACED by a new group; afterwards
  // a lone-seat monitor cannot start on a reservation the group moves.
  const single = await post(body([{ bookingId: 9301, slotId: 41 }]).replace(/,"members":\[[^\]]*\]/, ''));
  assert.strictEqual(single.status, 200, 'single-seat monitor created');
  const grp2 = await post(body([{ bookingId: 9301, slotId: 41 }, { bookingId: 9302, slotId: 42 }]));
  assert.strictEqual(grp2.status, 200, 'group accepted over an existing single-seat monitor');
  const all = await (await fetch(`${BASE}/api/auto-upgrade`, { headers: H(t) })).json();
  const live = all.filter((u) => u.status === 'active' && (u.booking_id === 9301 || (u.members || []).some((m) => m.booking_id === 9301)));
  assert.strictEqual(live.length, 1, 'exactly one live monitor covers booking 9301');
  assert.strictEqual(live[0].members.length, 2, 'and it is the group');
  const lone = await post(body([{ bookingId: 9302, slotId: 42 }]).replace(/,"members":\[[^\]]*\]/, ''));
  assert.strictEqual(lone.status, 409, 'lone-seat monitor refused on a grouped reservation');
  console.log('✅ /api/auto-upgrade: group accepted, duplicate and guest refused, members listed.');
}

(async () => {
  let failed = 0;
  try { await run(); } catch (e) { failed = 1; console.error('❌', e.stack || e.message); }
  cleanup();
  process.exit(failed);
})();
