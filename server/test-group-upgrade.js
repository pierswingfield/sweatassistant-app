// Group Auto-Upgrade: several of one member's reservations on one class, moved only
// TOGETHER. Two layers:
//   1. planGroupUpgrade (pure): target-set selection, "better" and "at least as together".
//   2. the poller executing a plan against an in-memory fake gym (provider methods are
//      stubbed on the adapter prototypes), covering book-first, cancel-first with
//      recovery, partial failure, claim collisions and guest groups.
// Mocks only; nothing here talks to a real gym.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';

const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(os.tmpdir(), `group-upgrade-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('./db');
const testkit = require('./testkit');
const pushService = require('./push');
const { planGroupUpgrade } = require('./group-upgrade');
const CodexFitProvider = require('./providers/codexfit');
const MarianaTekProvider = require('./providers/marianatek');

// ── Layer 1: pure planning ───────────────────────────────────────────────────
// Two rows of six seats: 11..16 (y=0) and 21..26 (y=100), pitch 100.
const layout = [];
[0, 1].forEach((r) => [0, 1, 2, 3, 4, 5].forEach((c) => layout.push({ id: (r + 1) * 10 + c + 1, x: c * 100, y: r * 100, label: String((r + 1) * 10 + c + 1) })));
const all = layout.map((s) => String(s.id));
const plan = (o) => planGroupUpgrade({ layoutSlots: layout, availableSlotIds: all, ...o });

function pureChecks() {
  // better + together: a poor adjacent pair moves to the best adjacent pair.
  let p = plan({ currentSlotIds: ['25', '26'], preferredOrder: ['11', '12', '13'] });
  assert.deepStrictEqual([...p.targetSlotIds].sort(), ['11', '12'], 'moves to the best adjacent pair');
  assert.strictEqual(p.moves.length, 2);

  // Best-ranked seats are split apart (11 and 16); an adjacent, slightly worse pair must win.
  p = plan({ currentSlotIds: ['25', '26'], preferredOrder: ['11', '16', '13', '14'], availableSlotIds: ['11', '16', '13', '14', '25', '26'] });
  assert.deepStrictEqual([...p.targetSlotIds].sort(), ['13', '14'], 'never splits the group for a better rank');

  // Only split seats are better: no move.
  assert.strictEqual(plan({ currentSlotIds: ['25', '26'], preferredOrder: ['11', '16'], availableSlotIds: ['11', '16', '25', '26'] }), null, 'better but split = no move');

  // Pareto: a set that improves one seat by worsening the other is not "better".
  // Sum of ranks would improve (3 < 4) but the best seat would get worse (0 -> 1).
  assert.strictEqual(plan({ currentSlotIds: ['11', '12'], preferredOrder: ['11', '21', '22', '23'] }), null, 'cannot trade the best seat away');

  // Already optimal.
  assert.strictEqual(plan({ currentSlotIds: ['11', '12'], preferredOrder: ['11', '12', '13'] }), null);

  // At-least-as-together: a spread-out pair is not collapsed into a looser one.
  assert.strictEqual(plan({ currentSlotIds: ['25', '26'], preferredOrder: ['11', '13'], availableSlotIds: ['11', '13', '25', '26'] }), null, 'looser than current = no move');

  // The together flag lets an equal-rank-but-tighter set count as an improvement.
  const noFlag = plan({ currentSlotIds: ['11', '13'], preferredOrder: ['11', '13', '12'], availableSlotIds: ['11', '13', '12'] });
  assert.strictEqual(noFlag, null, 'without the flag, no rank gain = no move');
  const withFlag = plan({ currentSlotIds: ['11', '13'], preferredOrder: ['11', '12', '13'], availableSlotIds: ['11', '12', '13'], prioritizeTogether: true });
  assert.ok(withFlag, 'with the flag, a tighter set at no worse rank is taken');
  assert.deepStrictEqual([...withFlag.targetSlotIds].sort(), ['11', '12']);

  // Unknown geometry: never move a group blind.
  const blind = planGroupUpgrade({ layoutSlots: layout.map((s) => ({ id: s.id })), availableSlotIds: all, currentSlotIds: ['25', '26'], preferredOrder: ['11', '12'] });
  assert.strictEqual(blind, null);

  // A seat the group does not hold and that is not free is never targeted.
  p = plan({ currentSlotIds: ['25', '26'], preferredOrder: ['11', '12', '13', '14'], availableSlotIds: ['13', '14', '25', '26'] });
  assert.deepStrictEqual([...p.targetSlotIds].sort(), ['13', '14']);
  console.log('✅ planGroupUpgrade: better, at-least-as-together, Pareto, flag, blind geometry.');
}

// ── Layer 2: a tiny fake gym behind the adapters ─────────────────────────────
const fake = {};   // gymId -> state
const pushes = [];
pushService.sendNotification = async (userId, title, body) => { pushes.push({ userId, title, body }); };

let counter = 9000;
function resetGym(gymId, { eventId, held, credits = 5, maxBookable = 6 } = {}) {
  fake[gymId] = { eventId: String(eventId), held: new Map(held.map(([bid, slot, token, ev]) => [String(bid), { slot: String(slot), token, event: ev }])), credits, maxBookable, failBook: new Set(), throwBook: new Set(), throwCancel: new Set(), delayMs: 0, failCancel: new Set(), failSwap: new Set(), ops: [], penalty: false };
}
const tokenOf = (s) => (s && (s.accessToken || s.jwt)) || 'none';
const heldSlots = (G) => new Set([...G.held.values()].map((h) => h.slot));
const detailsFor = (G) => ({
  event: { id: G.eventId, credits: { required: 1 } },
  slots: layout.map((s) => ({ ...s, id: String(s.id), isAvailable: !heldSlots(G).has(String(s.id)) })),
  maxBookableSlots: G.maxBookable,
});
const resp = (body, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => body });

for (const P of [CodexFitProvider, MarianaTekProvider]) {
  P.prototype.fetchEventDetails = async function () { return detailsFor(fake[this.gym.id]); };
  P.prototype.listBookings = async function (session) {
    const G = fake[this.gym.id];
    return [...G.held].filter(([, h]) => h.token === tokenOf(session))
      .map(([bid, h]) => ({ bookingId: bid, eventId: h.event ? String(h.event) : G.eventId, slotId: h.slot, isWaitlist: false, isGuest: false }));
  };
}
CodexFitProvider.prototype.bookSlot = async function (eventId, slots, session) {
  const G = fake[this.gym.id]; const slot = String(slots[0]); const tok = tokenOf(session);
  G.ops.push(`book:${slot}@${tok}`);
  if (G.delayMs) await new Promise((r) => setTimeout(r, G.delayMs));
  if (G.throwBook.has('*') || G.throwBook.has(slot)) throw new Error('relogin failed');
  if (G.failBook.has('*') || G.failBook.has(slot) || heldSlots(G).has(slot)) return { ok: false, code: 'SPOT_UNAVAILABLE', error: 'taken' };
  const id = String(++counter); G.held.set(id, { slot, token: tok });
  return { ok: true, bookingId: id, slotId: slot };
};
CodexFitProvider.prototype.getCancelPenalty = async function () { return { isPenalty: fake[this.gym.id].penalty }; };
CodexFitProvider.prototype.request = async function (p, opts = {}) {
  const G = fake[this.gym.id]; const tok = opts.token;
  if (p === '/profile') return resp({ data: { available_credits: G.credits > 0 ? [{ count: G.credits, credit_type: { id: 1, is_guest_use_only: false } }] : [] } });
  const m = p.match(/^\/bookings\/(\d+)$/);
  if (m && opts.method === 'DELETE') {
    G.ops.push(`cancel:${m[1]}@${tok}`);
    if (G.throwCancel.has(m[1])) throw new Error('network down');
    if (G.failCancel.has(m[1])) return resp({ message: 'nope' }, false);
    G.held.delete(m[1]);
    return resp({ success: true });
  }
  return resp({}, false, 404);
};
MarianaTekProvider.prototype.swapSpots = async function (bookingId, cur, target, session) {
  const G = fake[this.gym.id]; const tok = tokenOf(session);
  G.ops.push(`swap:${bookingId}->${target}@${tok}`);
  if (G.failSwap.has(String(target)) || heldSlots(G).has(String(target))) return { ok: false, error: 'swap refused' };
  G.held.get(String(bookingId)).slot = String(target);
  return { ok: true, bookingId: String(bookingId), slotId: String(target) };
};

let seq = 0;
function psycleUser() {
  const n = ++seq; const tok = `tok-psy-${n}`;
  const id = testkit.createUser(db, `grp${n}@test.com`, 'x');
  db.updateUserJWT(id, tok, new Date(Date.now() + 864e5).toISOString());
  return { id, tok };
}
function jabUser() {
  const n = ++seq; const tok = `tok-jab-${n}`;
  const id = db.createAccount(`jabgrp${n}@test.com`, 'password123');
  db.upsertUserGym(id, 'jab-boxing', { gym_email: `jabgrp${n}@test.com`, session_json: JSON.stringify({ accessToken: tok, refreshToken: 'r' }), status: 'active' });
  return { id, tok };
}
const startAt = () => new Date(Date.now() + 2 * 864e5).toISOString();
function addGroup(user, gymId, eventId, members, prefs, preferredSlots, extra = {}) {
  const studioId = gymId === 'jab-boxing' ? 'room-1' : 138;
  const uid = db.runWithGymContext(user.id, gymId, () => {
    db.setStudioPreference(user.id, studioId, { preferredSlots, preferredRows: [] });
    return db.addAutoUpgrade(user.id, eventId, members[0].bookingId, members[0].slotId, 'Ride 45', 'I', 'Studio', 'Loc', startAt(), prefs, studioId, 'RIDE', gymId, members);
  });
  if (extra.guestFlag) db.db.prepare('UPDATE auto_upgrade_members SET is_guest = 1 WHERE upgrade_id = ? AND booking_id = ?').run(uid, members[1].bookingId);
  return uid;
}
const monitor = (id) => db.db.prepare('SELECT * FROM auto_upgrades WHERE id = ?').get(id);
const membersOf = (id) => db.getAutoUpgradeMembers(id).map((m) => ({ b: m.booking_id, s: m.slot_id }));
const slotsOf = (id) => membersOf(id).map((m) => m.s).sort();
const cancelsOf = (G) => G.ops.filter((o) => o.startsWith('cancel:')).map((o) => o.split(':')[1].split('@')[0]);

async function engineChecks(poller) {
  const GYM = 'psycle-london';
  const clearMonitors = () => { db.db.prepare('DELETE FROM auto_upgrades').run(); pushes.length = 0; };

  // 1) book-first success, with an unrelated third reservation that must never be touched.
  clearMonitors();
  let u = psycleUser();
  resetGym(GYM, { eventId: 'E1', held: [[5001, 25, u.tok], [5002, 26, u.tok], [5003, 14, u.tok]] });
  let id = addGroup(u, GYM, 'E1', [{ bookingId: 5001, slotId: '25' }, { bookingId: 5002, slotId: '26' }], {}, ['11', '12', '13']);
  await poller.executeAutoUpgradeChecks();
  let G = fake[GYM];
  assert.deepStrictEqual(G.ops.filter((o) => !o.startsWith('book:') || true), [
    `book:11@${u.tok}`, `cancel:5002@${u.tok}`, `book:12@${u.tok}`, `cancel:5001@${u.tok}`,
  ], 'book-first: the new spot is booked BEFORE the old one is released, one member at a time');
  assert.deepStrictEqual(slotsOf(id), ['11', '12']);
  assert.ok(G.held.has('5003') && G.held.get('5003').slot === '14', 'an unrelated reservation is never touched');
  assert.ok(cancelsOf(G).every((c) => ['5001', '5002'].includes(c)), 'only group bookings are ever cancelled');
  assert.strictEqual(monitor(id).status, 'active');
  console.log('✅ Book-first: book, then cancel, per member; unrelated reservation untouched.');

  // 2) book-first impossible (no spare credit) -> cancel then rebook.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E2', held: [[5101, 25, u.tok], [5102, 26, u.tok]], credits: 0 });
  id = addGroup(u, GYM, 'E2', [{ bookingId: 5101, slotId: '25' }, { bookingId: 5102, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  G = fake[GYM];
  assert.deepStrictEqual(G.ops, [`cancel:5102@${u.tok}`, `book:11@${u.tok}`, `cancel:5101@${u.tok}`, `book:12@${u.tok}`], 'no spare credit: cancel then rebook');
  assert.deepStrictEqual(slotsOf(id), ['11', '12']);
  // ... and the same when the per-class self limit leaves no room for an extra reservation.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E2b', held: [[5111, 25, u.tok], [5112, 26, u.tok]], maxBookable: 2 });
  id = addGroup(u, GYM, 'E2b', [{ bookingId: 5111, slotId: '25' }, { bookingId: 5112, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.ok(fake[GYM].ops[0].startsWith('cancel:'), 'at the self limit: cancel first');
  console.log('✅ Book-first impossible (no credit / at limit): cancel-first path.');

  // 3) cancel-first recovery: target taken -> rebook the ORIGINAL spot, abort the rest.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E3', held: [[5201, 25, u.tok], [5202, 26, u.tok]], credits: 0 });
  fake[GYM].failBook.add('11');
  id = addGroup(u, GYM, 'E3', [{ bookingId: 5201, slotId: '25' }, { bookingId: 5202, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  G = fake[GYM];
  assert.deepStrictEqual(G.ops, [`cancel:5202@${u.tok}`, `book:11@${u.tok}`, `book:26@${u.tok}`], 'target failed: original rebooked, remaining moves aborted');
  assert.deepStrictEqual(slotsOf(id), ['25', '26'], 'group is exactly as before');
  assert.ok(!membersOf(id).some((m) => m.b === 5202), 'member follows the re-booked reservation id');
  assert.strictEqual(monitor(id).status, 'active');
  console.log('✅ Recovery: original spot re-booked, remaining moves aborted.');

  // 3b) original also gone -> nearest free spot; 3c) nothing can be re-booked -> lost spot.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E3b', held: [[5211, 25, u.tok], [5212, 26, u.tok]], credits: 0 });
  fake[GYM].failBook.add('11'); fake[GYM].failBook.add('26');
  id = addGroup(u, GYM, 'E3b', [{ bookingId: 5211, slotId: '25' }, { bookingId: 5212, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.ok(slotsOf(id).includes('16'), 'nearest free spot (directly above the original) used');
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.ok(pushes.length === 1 && /part/i.test(pushes[0].title), 'member told the group was only partly moved');
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E3c', held: [[5221, 25, u.tok], [5222, 26, u.tok]], credits: 0 });
  fake[GYM].failBook.add('*');
  id = addGroup(u, GYM, 'E3c', [{ bookingId: 5221, slotId: '25' }, { bookingId: 5222, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.ok(pushes.some((p) => /lost/i.test(p.title)), 'a lost spot is announced');
  assert.strictEqual(cancelsOf(fake[GYM]).length, 1, 'aborted after the first failed move');
  console.log('✅ Recovery ladder: original -> nearest -> lost spot notification.');

  // 4) partial failure on book-first: second move fails after the first landed.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E4', held: [[5301, 25, u.tok], [5302, 26, u.tok]] });
  fake[GYM].failBook.add('12');
  id = addGroup(u, GYM, 'E4', [{ bookingId: 5301, slotId: '25' }, { bookingId: 5302, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  G = fake[GYM];
  assert.deepStrictEqual(G.ops, [`book:11@${u.tok}`, `cancel:5302@${u.tok}`, `book:12@${u.tok}`], 'stops at the first failure; nothing else is cancelled');
  assert.deepStrictEqual(slotsOf(id), ['11', '25']);
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.ok(pushes.length === 1 && /part/i.test(pushes[0].title), 'partial move notification sent');
  console.log('✅ Partial failure: aborted, monitor stopped, member notified.');

  // 4b) a failed cancel after a successful book-first never cancels anything else.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E4b', held: [[5311, 25, u.tok], [5312, 26, u.tok]] });
  fake[GYM].failCancel.add('5312');
  id = addGroup(u, GYM, 'E4b', [{ bookingId: 5311, slotId: '25' }, { bookingId: 5312, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(cancelsOf(fake[GYM]), ['5312'], 'one cancel attempt, then abort');
  assert.strictEqual(monitor(id).status, 'stopped');
  console.log('✅ Cancel failure after book-first aborts and notifies.');

  // 5) atomic swap gym: sequential swaps, then a failure part way.
  clearMonitors();
  const JAB = 'jab-boxing';
  let j = jabUser();
  resetGym(JAB, { eventId: 'E5', held: [[6001, 25, j.tok], [6002, 26, j.tok]] });
  id = addGroup(j, JAB, 'E5', [{ bookingId: 6001, slotId: '25' }, { bookingId: 6002, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(fake[JAB].ops, [`swap:6002->11@${j.tok}`, `swap:6001->12@${j.tok}`], 'sequential atomic swaps, no cancel');
  assert.deepStrictEqual(slotsOf(id), ['11', '12']);
  clearMonitors();
  j = jabUser();
  resetGym(JAB, { eventId: 'E5b', held: [[6011, 25, j.tok], [6012, 26, j.tok]] });
  fake[JAB].failSwap.add('12');
  id = addGroup(j, JAB, 'E5b', [{ bookingId: 6011, slotId: '25' }, { bookingId: 6012, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.ok(pushes.some((p) => /part/i.test(p.title)));
  assert.strictEqual(cancelsOf(fake[JAB]).length, 0);
  console.log('✅ Atomic gym: sequential swaps; partial failure stops and notifies.');

  // 6) claim collision: two users want the same target seats in one cycle; the second is held back.
  //    A JAB group with the SAME event id and seat ids in the same cycle is NOT blocked (gym-qualified keys).
  clearMonitors();
  const a = psycleUser(); const b = psycleUser(); const jj = jabUser();
  resetGym(GYM, { eventId: 'E6', held: [[7001, 25, a.tok], [7002, 26, a.tok], [7003, 23, b.tok], [7004, 24, b.tok]] });
  resetGym(JAB, { eventId: 'E6', held: [[7101, 25, jj.tok], [7102, 26, jj.tok]] });
  const ia = addGroup(a, GYM, 'E6', [{ bookingId: 7001, slotId: '25' }, { bookingId: 7002, slotId: '26' }], {}, ['11', '12']);
  const ib = addGroup(b, GYM, 'E6', [{ bookingId: 7003, slotId: '23' }, { bookingId: 7004, slotId: '24' }], {}, ['11', '12']);
  const ij = addGroup(jj, JAB, 'E6', [{ bookingId: 7101, slotId: '25' }, { bookingId: 7102, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  const bookedBy = (tok) => fake[GYM].ops.filter((o) => o.startsWith('book:') && o.endsWith(`@${tok}`));
  const winners = [a, b].filter((x) => bookedBy(x.tok).length > 0);
  assert.strictEqual(winners.length, 1, 'exactly one of two colliding groups moved');
  const loser = winners[0] === a ? ib : ia;
  assert.ok(['23', '24'].every((s) => slotsOf(loser).includes(s)) || ['25', '26'].every((s) => slotsOf(loser).includes(s)), 'loser untouched');
  assert.deepStrictEqual(slotsOf(ij), ['11', '12'], 'same event/seat ids on ANOTHER gym are not blocked');
  console.log('✅ Claim collision: one winner per gym; claims are gym-qualified.');

  // 7) guest groups are never moved.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E7', held: [[8001, 25, u.tok], [8002, 26, u.tok]] });
  id = addGroup(u, GYM, 'E7', [{ bookingId: 8001, slotId: '25' }, { bookingId: 8002, slotId: '26' }], {}, ['11', '12'], { guestFlag: true });
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(fake[GYM].ops, [], 'no provider call for a guest group');
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.match(monitor(id).status_message, /guest/i);
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E7b', held: [[8011, 25, u.tok], [8012, 26, u.tok]] });
  id = addGroup(u, GYM, 'E7b', [{ bookingId: 8011, slotId: '25' }, { bookingId: 8012, slotId: '26' }], {}, ['11', '12']);
  db.upsertGuestBookingGroup(u.id, GYM, 'E7b', '8011', '8099');
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(fake[GYM].ops, [], 'a guest reservation on the class also blocks the group');
  assert.strictEqual(monitor(id).status, 'stopped');
  console.log('✅ Guest groups are blocked server-side.');

  // 8) a group without an atomic swap does not use the keep-original final attempt.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E8', held: [[8101, 25, u.tok], [8102, 26, u.tok]] });
  id = addGroup(u, GYM, 'E8', [{ bookingId: 8101, slotId: '25' }, { bookingId: 8102, slotId: '26' }], { keepOriginalOnCutoff: true }, ['11', '12']);
  db.db.prepare('UPDATE auto_upgrades SET start_at = ? WHERE id = ?').run(new Date(Date.now() + 6 * 3600e3).toISOString(), id);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(fake[GYM].ops, []);
  assert.strictEqual(monitor(id).status, 'stopped');
  console.log('✅ Cutoff: non-atomic group stops at 12h, never holds 2N seats.');

  // 9) [Claude 2026-10-11] a throw AFTER the cancel (relogin failure) must not lose the spot silently.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E9', held: [[9101, 25, u.tok], [9102, 26, u.tok]], credits: 0 });
  fake[GYM].throwBook.add('*');
  id = addGroup(u, GYM, 'E9', [{ bookingId: 9101, slotId: '25' }, { bookingId: 9102, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.strictEqual(monitor(id).status, 'stopped', 'unrecoverable state stops the monitor');
  assert.ok(!membersOf(id).some((m) => m.b === 9102), 'persisted state drops the cancelled booking');
  assert.ok(pushes.some((p) => /lost/i.test(p.title)), 'the lost spot is announced');
  // ... and when only the target throws, the original is recovered and persisted with its NEW id.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E9b', held: [[9111, 25, u.tok], [9112, 26, u.tok]], credits: 0 });
  fake[GYM].throwBook.add('11');
  id = addGroup(u, GYM, 'E9b', [{ bookingId: 9111, slotId: '25' }, { bookingId: 9112, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  G = fake[GYM];
  assert.deepStrictEqual(slotsOf(id), ['25', '26']);
  const liveIds = [...G.held.keys()].sort();
  assert.deepStrictEqual(membersOf(id).map((m) => String(m.b)).sort(), liveIds, 'member booking ids equal the live ids (none stale)');
  console.log('✅ A throw after cancel is recovered in-loop; member state persisted.');

  // 9c) book-first: cancel of the old spot throws -> persisted state points at the new spot, "extra spot" told.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E9c', held: [[9121, 25, u.tok], [9122, 26, u.tok]] });
  fake[GYM].throwCancel.add('9122');
  id = addGroup(u, GYM, 'E9c', [{ bookingId: 9121, slotId: '25' }, { bookingId: 9122, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.ok(slotsOf(id).includes('11'), 'state follows the new spot');
  assert.ok(pushes.some((p) => /extra/i.test(p.title + p.body)), 'member told an extra spot is held');
  console.log('✅ Book-first: cancel throw persisted and reported as an extra spot.');

  // 10) no session -> nothing is mutated.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E10', held: [[9201, 25, u.tok], [9202, 26, u.tok]], credits: 0 });
  id = addGroup(u, GYM, 'E10', [{ bookingId: 9201, slotId: '25' }, { bookingId: 9202, slotId: '26' }], {}, ['11', '12']);
  const realList = CodexFitProvider.prototype.listBookings;
  CodexFitProvider.prototype.listBookings = async function () { const G2 = fake[this.gym.id]; return [...G2.held].map(([bid, h]) => ({ bookingId: bid, eventId: G2.eventId, slotId: h.slot, isWaitlist: false, isGuest: false })); };
  db.db.prepare("UPDATE user_gyms SET session_json = NULL WHERE user_id = ? AND gym_id = ?").run(u.id, GYM);
  db.db.prepare('UPDATE users SET jwt = NULL WHERE id = ?').run(u.id);
  await poller.executeAutoUpgradeChecks();
  CodexFitProvider.prototype.listBookings = realList;
  assert.deepStrictEqual(fake[GYM].ops, [], 'no cancel or book without a session');
  console.log('✅ No session: nothing mutated.');

  // 11) a member whose booking belongs to ANOTHER event is never cancelled.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E11', held: [[9301, 25, u.tok], [9302, 26, u.tok, 'OTHER']], credits: 0 });
  id = addGroup(u, GYM, 'E11', [{ bookingId: 9301, slotId: '25' }, { bookingId: 9302, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  assert.ok(!cancelsOf(fake[GYM]).includes('9302'), 'a booking on another event is never cancelled');
  assert.strictEqual(monitor(id).status, 'stopped');
  console.log('✅ Poller re-verifies each member belongs to the monitor event.');

  // 12) after a recovery the monitor backs off instead of churning every cycle.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E12', held: [[9401, 25, u.tok], [9402, 26, u.tok]], credits: 0 });
  fake[GYM].failBook.add('11');
  id = addGroup(u, GYM, 'E12', [{ bookingId: 9401, slotId: '25' }, { bookingId: 9402, slotId: '26' }], {}, ['11', '12']);
  await poller.executeAutoUpgradeChecks();
  const opsAfterFirst = fake[GYM].ops.length;
  db.db.prepare('UPDATE auto_upgrades SET last_checked_at = NULL WHERE id = ?').run(id);
  await poller.executeAutoUpgradeChecks();
  assert.strictEqual(fake[GYM].ops.length, opsAfterFirst, 'cooldown: no cancel/rebook churn on the next cycle');
  console.log('✅ Recovery cooldown prevents churn.');

  // 13) overlapping cycles do not run the same group twice.
  clearMonitors();
  u = psycleUser();
  resetGym(GYM, { eventId: 'E13', held: [[9501, 25, u.tok], [9502, 26, u.tok]] });
  fake[GYM].delayMs = 150;
  id = addGroup(u, GYM, 'E13', [{ bookingId: 9501, slotId: '25' }, { bookingId: 9502, slotId: '26' }], {}, ['11', '12']);
  await Promise.all([poller.executeAutoUpgradeChecks(), poller.executeAutoUpgradeChecks()]);
  assert.strictEqual(fake[GYM].ops.filter((o) => o.startsWith('book:')).length, 2, 'exactly one run books the two target seats');
  assert.deepStrictEqual(slotsOf(id), ['11', '12']);
  console.log('✅ In-flight guard: overlapping cycles act once.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 Group Auto-Upgrade\n');
  try {
    pureChecks();
    await engineChecks(require('./poller'));
    console.log('\n🎉 GROUP AUTO-UPGRADE CHECKS PASSED.\n');
  } catch (err) {
    failed = 1;
    console.error('\n❌ Group auto-upgrade test FAILED:\n', err, '\n');
  } finally {
    for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} }
  }
  process.exit(failed);
})();
