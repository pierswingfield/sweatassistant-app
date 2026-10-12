// Cancel & rebook upgrade policy ([Claude 2026-10-11]): per-gym setting `autoUpgradeCancelRebook`,
// pure policy conditions, and the poller's single-spot and group paths. Mocks only.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.NODE_ENV = 'test';
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const tmpDb = path.join(os.tmpdir(), `cancel-rebook-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const db = require('./db');
const testkit = require('./testkit');
const pushService = require('./push');
const policy = require('./cancel-rebook-policy');
const CodexFitProvider = require('./providers/codexfit');

const GYM = 'psycle-london';
const base = { enabled: true, atomic: false, bookFirstPossible: false, freeSpots: 5, hoursUntilClass: 48, isCutoffMode: false, penaltyNone: true };

function policyChecks() {
  assert.strictEqual(policy.CANCEL_REBOOK_DEFAULT, true, 'default is ON (single constant)');
  assert.strictEqual(policy.cancelRebookEnabled({}), true);
  assert.strictEqual(policy.cancelRebookEnabled({ autoUpgradeCancelRebook: false }), false);
  assert.strictEqual(policy.cancelRebookEnabled({ autoUpgradeCancelRebook: true }), true);
  const gc = (v) => ({ capabilities: { cancelRebookUpgrade: v } });
  assert.strictEqual(policy.cancelRebookEnabled({}, gc(true)), true);
  assert.strictEqual(policy.cancelRebookEnabled({ autoUpgradeCancelRebook: true }, gc(false)), false, 'capability off beats the setting');
  assert.strictEqual(policy.cancelRebookEnabled({}, gc(undefined)), false, 'missing capability is off server-side');
  assert.strictEqual(policy.cancelRebookEnabled({}, null), false);
  const cfgs = require('./gyms.config');
  assert.strictEqual(cfgs.getGymConfig('psycle-london').capabilities.cancelRebookUpgrade, false);
  assert.strictEqual(cfgs.getGymConfig('jab-boxing').capabilities.cancelRebookUpgrade, false);
  assert.strictEqual(cfgs.getGymConfig('aarmy').capabilities.cancelRebookUpgrade, false);
  assert.strictEqual(policy.cancelRebookEnabled({ autoUpgradeCancelRebook: true }, cfgs.getGymConfig('psycle-london')), false, 'Psycle (native swap) never cancels and rebooks, whatever the stored setting');
  assert.strictEqual(policy.evaluateCancelRebook(base).allowed, true);
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, bookFirstPossible: true }).reason, 'book-first', 'spare credit: book-first');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, enabled: false }).reason, 'setting-off');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, freeSpots: 2 }).reason, 'few-spots');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, freeSpots: 3 }).allowed, true, '3 free spots is enough');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, penaltyNone: false }).reason, 'penalty');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, hoursUntilClass: 11 }).reason, 'cutoff');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, hoursUntilClass: 12 }).reason, 'cutoff');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, isCutoffMode: true }).reason, 'cutoff');
  assert.strictEqual(policy.evaluateCancelRebook({ ...base, atomic: true }).allowed, false, 'atomic gyms never cancel-rebook');
  assert.strictEqual(policy.penaltyIsNone({ isPenalty: false, penalty: 'none' }), true);
  assert.strictEqual(policy.penaltyIsNone({ isPenalty: false, penalty: 'credit' }), false);
  assert.strictEqual(policy.penaltyIsNone(undefined), false, 'unreadable answer fails closed');
  console.log('✅ Policy: each condition blocks; setting off blocks; defaults.');
}

// ── fake CodexFit gym ───────────────────────────────────────────────────────
const layout = [];
for (let i = 1; i <= 12; i++) layout.push({ id: i, x: i * 100, y: 0, label: String(i) });
const pushes = [];
pushService.sendNotification = async (userId, title, body) => { pushes.push({ userId, title, body }); };
let G; let counter = 7000;
const resp = (body, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => body });
const tokenOf = (s) => (s && (s.accessToken || s.jwt)) || 'none';
function reset({ held, credits = 0, maxBookable = 6, penalty = false, otherTaken = [] }) {
  G = { held: new Map(held.map(([b, s, t]) => [String(b), { slot: String(s), token: t }])), other: new Set(otherTaken.map(String)), credits, maxBookable, penalty, ops: [], failBook: new Set(), cancelMode: null, noId: false, listThrows: false, pushThrows: false };
}
const taken = () => new Set([...[...G.held.values()].map((h) => h.slot), ...G.other]);
CodexFitProvider.prototype.fetchEventDetails = async function () {
  return { event: { id: 'E', credits: { required: 1 } }, slots: layout.map((s) => ({ ...s, id: String(s.id), isAvailable: !taken().has(String(s.id)) })), maxBookableSlots: G.maxBookable };
};
CodexFitProvider.prototype.listBookings = async function (session) {
  if (G.listThrows) throw new Error('list down');
  return [...G.held].filter(([, h]) => h.token === tokenOf(session)).map(([bid, h]) => ({ bookingId: bid, eventId: 'E', slotId: h.slot, isWaitlist: false, isGuest: false }));
};
CodexFitProvider.prototype.bookSlot = async function (eventId, slots, session) {
  const slot = String(slots[0]); G.ops.push(`book:${slot}`);
  if (G.failBook.has(slot) || taken().has(slot)) return { ok: false, code: 'SPOT_UNAVAILABLE', error: 'taken' };
  const id = String(++counter); G.held.set(id, { slot, token: tokenOf(session) });
  return { ok: true, bookingId: G.noId ? 0 : id, slotId: slot };
};
CodexFitProvider.prototype.getCancelPenalty = async function () { return { isPenalty: G.penalty, penalty: G.penalty ? 'credit' : 'none' }; };
CodexFitProvider.prototype.request = async function (p, opts = {}) {
  if (p === '/profile') return resp({ data: { available_credits: G.credits > 0 ? [{ count: G.credits, credit_type: { id: 1, is_guest_use_only: false } }] : [] } });
  const m = p.match(/^\/bookings\/(\d+)$/);
  if (m && opts.method === 'DELETE') {
    G.ops.push(`cancel:${m[1]}`);
    if (G.cancelMode === 'applied-then-throws') { G.held.delete(m[1]); throw new Error('timeout'); }
    if (G.cancelMode === 'throws') throw new Error('timeout');
    G.held.delete(m[1]); return resp({ success: true });
  }
  return resp({}, false, 404);
};

let seq = 0;
function user() {
  const n = ++seq; const tok = `tok-cr-${n}`;
  const id = testkit.createUser(db, `cr${n}@test.com`, 'x');
  db.updateUserJWT(id, tok, new Date(Date.now() + 864e5).toISOString());
  return { id, tok };
}
const startAt = () => new Date(Date.now() + 2 * 864e5).toISOString();
function addMonitor(u, bookingId, slotId, preferred, members) {
  return db.runWithGymContext(u.id, GYM, () => {
    db.setStudioPreference(u.id, 138, { preferredSlots: preferred, preferredRows: [] });
    return db.addAutoUpgrade(u.id, 'E', bookingId, slotId, 'Ride 45', 'I', 'Studio', 'Loc', startAt(), {}, 138, 'RIDE', GYM, members);
  });
}
const monitor = (id) => db.db.prepare('SELECT * FROM auto_upgrades WHERE id = ?').get(id);
const setSetting = (u, v) => db.runWithGymContext(u.id, GYM, () => db.setUserSettings(u.id, { autoUpgradeCancelRebook: v }));

async function engineChecks(poller) {
  const clear = () => { db.db.prepare('DELETE FROM auto_upgrades').run(); pushes.length = 0; };

  // Single spot, no credit, default setting: cancel then rebook.
  clear(); let u = user();
  reset({ held: [[6001, 9, u.tok]] });
  let id = addMonitor(u, 6001, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, ['cancel:6001', 'book:1'], 'single spot uses the new cancel-first path');
  assert.strictEqual(String(monitor(id).current_slot_id), '1');
  assert.strictEqual(monitor(id).status, 'active');
  console.log('✅ Single spot, no spare credit: cancel & rebook (default ON).');

  // Spare credit: book-first (book new, then cancel old).
  clear(); u = user();
  reset({ held: [[6101, 9, u.tok]], credits: 3 });
  id = addMonitor(u, 6101, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, ['book:1', 'cancel:6101'], 'spare credit: book first');
  console.log('✅ Single spot with a spare credit: book-first preferred.');

  // Setting off: nothing cancels.
  clear(); u = user(); setSetting(u, false);
  reset({ held: [[6201, 9, u.tok]] });
  id = addMonitor(u, 6201, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, [], 'setting off: no cancel, no booking');
  assert.strictEqual(monitor(id).status, 'paused_no_credits', 'setting off keeps the old no-credit pause');
  console.log('✅ Setting off blocks cancel & rebook (single).');

  // Capability off for the gym: whatever the stored setting (default ON) says, no cancel & rebook.
  {
    const caps = require('./gyms.config').getGymConfig(GYM).capabilities;
    const prev = caps.cancelRebookUpgrade;
    clear(); u = user(); setSetting(u, true);
    reset({ held: [[6251, 9, u.tok]] });
    id = addMonitor(u, 6251, '9', ['1']);
    caps.cancelRebookUpgrade = false;
    try { await poller.executeAutoUpgradeChecks(); } finally { caps.cancelRebookUpgrade = prev; }
    assert.deepStrictEqual(G.ops, [], 'capability off: no cancel, no booking even with the setting on');
    console.log('✅ Capability cancelRebookUpgrade=false blocks cancel & rebook despite the setting.');
  }

  // Fewer than 3 free spots (12 seats: 9 held by others + own = 10 taken, 2 free).
  clear(); u = user();
  reset({ held: [[6301, 9, u.tok]], otherTaken: [2, 3, 4, 5, 6, 7, 8, 10, 11] });
  id = addMonitor(u, 6301, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, [], '2 free spots: no move');
  assert.strictEqual(monitor(id).status, 'active');
  console.log('✅ Fewer than 3 free spots blocks (single).');

  // Penalty period.
  clear(); u = user();
  reset({ held: [[6401, 9, u.tok]], penalty: true });
  id = addMonitor(u, 6401, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, [], 'penalty: no move');
  console.log('✅ Cancellation-penalty period blocks (single).');

  // Target taken between cancel and rebook: original re-booked.
  clear(); u = user();
  reset({ held: [[6501, 9, u.tok]] });
  G.failBook.add('1');
  id = addMonitor(u, 6501, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, ['cancel:6501', 'book:1', 'book:9'], 'failed rebook restores the original spot');
  assert.strictEqual(monitor(id).status, 'active');
  assert.ok([...G.held.values()].some((h) => h.slot === '9'), 'original held again');
  console.log('✅ Failed rebook restores the original spot.');


  // Review fixes: cancel error but cancelled upstream -> proceed to rebook.
  clear(); u = user();
  reset({ held: [[6701, 9, u.tok]] }); G.cancelMode = 'applied-then-throws';
  id = addMonitor(u, 6701, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, ['cancel:6701', 'book:1'], 'cancel error but gone upstream: rebook');
  assert.strictEqual(String(monitor(id).current_slot_id), '1');
  assert.notStrictEqual(monitor(id).booking_id, 6701, 'follows the new booking id');

  // Cancel error and still held: nothing changed, stays active.
  clear(); u = user();
  reset({ held: [[6711, 9, u.tok]] }); G.cancelMode = 'throws';
  id = addMonitor(u, 6711, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  assert.deepStrictEqual(G.ops, ['cancel:6711']);
  assert.strictEqual(monitor(id).status, 'active');

  // Cancel error and truth unknown: stop + notify.
  clear(); u = user();
  reset({ held: [[6721, 9, u.tok]] }); G.cancelMode = 'throws';
  id = addMonitor(u, 6721, '9', ['1']);
  const origList = CodexFitProvider.prototype.listBookings; let calls = 0;
  CodexFitProvider.prototype.listBookings = async function (s) { if (++calls > 1) throw new Error('list down'); return origList.call(this, s); };
  await poller.executeAutoUpgradeChecks();
  CodexFitProvider.prototype.listBookings = origList;
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.strictEqual(pushes.length, 1, 'member told to check bookings');

  // Rebook response without an id: resolved from live bookings, never undefined.
  clear(); u = user();
  reset({ held: [[6801, 9, u.tok]] }); G.noId = true;
  id = addMonitor(u, 6801, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  const liveId = [...G.held].find(([, h]) => h.slot === '1')[0];
  assert.strictEqual(String(monitor(id).booking_id), liveId, 'booking id resolved from live bookings');

  // Recovery without an id: resolved too.
  clear(); u = user();
  reset({ held: [[6811, 9, u.tok]] }); G.noId = true; G.failBook.add('1');
  id = addMonitor(u, 6811, '9', ['1']);
  await poller.executeAutoUpgradeChecks();
  const origId = [...G.held].find(([, h]) => h.slot === '9')[0];
  assert.strictEqual(String(monitor(id).booking_id), origId, 'recovered booking id resolved');
  assert.strictEqual(monitor(id).status, 'active');

  // Id unresolvable: stop + notify accurately.
  clear(); u = user();
  reset({ held: [[6821, 9, u.tok]] }); G.noId = true;
  id = addMonitor(u, 6821, '9', ['1']);
  let n = 0; CodexFitProvider.prototype.listBookings = async function (s) { if (++n > 1) throw new Error('list down'); return origList.call(this, s); };
  await poller.executeAutoUpgradeChecks();
  CodexFitProvider.prototype.listBookings = origList;
  assert.strictEqual(monitor(id).status, 'stopped');
  assert.strictEqual(pushes.length, 1);

  // A throwing push cannot skip state persistence.
  clear(); u = user();
  reset({ held: [[6831, 9, u.tok]] }); G.failBook.add('1');
  const origPush = pushService.sendNotification; 
  id = addMonitor(u, 6831, '9', ['1']);
  G.held.delete('6831'); // original cannot be restored: make rebook of 9 fail too
  G.failBook.add('9');
  pushService.sendNotification = async () => { throw new Error('push down'); };
  G.held.set('6831', { slot: '9', token: u.tok });
  await poller.executeAutoUpgradeChecks();
  pushService.sendNotification = origPush;
  assert.strictEqual(monitor(id).status, 'stopped', 'state persisted despite push failure');
  console.log('✅ Review fixes: cancel truth, id resolution, guarded persistence.');

  // Group: setting off / few spots / penalty each block; no credit, default ON still moves (test-group-upgrade).
  const grp = async (label, opts, setting, expectOps) => {
    clear(); u = user(); if (setting !== undefined) setSetting(u, setting);
    reset({ held: [[6601, 9, u.tok], [6602, 10, u.tok]], ...opts });
    const gid = addMonitor(u, 6601, '9', ['1', '2'], [{ bookingId: 6601, slotId: '9' }, { bookingId: 6602, slotId: '10' }]);
    await poller.executeAutoUpgradeChecks();
    assert.deepStrictEqual(G.ops, expectOps, label);
    return gid;
  };
  await grp('group: setting off blocks', {}, false, []);
  await grp('group: <3 free spots blocks', { otherTaken: [3, 4, 5, 6, 7, 8, 11, 12] }, undefined, []);
  await grp('group: penalty blocks', { penalty: true }, undefined, []);
  await grp('group: spare credit books first', { credits: 5 }, false, ['book:1', 'cancel:6602', 'book:2', 'cancel:6601']);
  console.log('✅ Group path: setting off, few spots, penalty block; spare credit books first even with setting off.');

  // Gym-scoped storage: the key never leaks to another linked gym or the account blob.
  u = user();
  db.upsertUserGym(u.id, 'jab-boxing', { gym_email: 'x@jab.test', session_json: JSON.stringify({ accessToken: 't', refreshToken: 'r' }), status: 'active' });
  setSetting(u, false);
  assert.strictEqual(db.getUserSettings(u.id, GYM).autoUpgradeCancelRebook, false);
  assert.strictEqual((db.getUserSettings(u.id, 'jab-boxing') || {}).autoUpgradeCancelRebook, undefined, 'not leaked to the other gym');
  const acct = db.db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?').get(u.id);
  assert.ok(!acct || !('autoUpgradeCancelRebook' in JSON.parse(acct.preferences)), 'not stored account-wide');
  console.log('✅ Setting is gym-scoped.');
}

(async () => {
  let failed = 0;
  console.log('\n🧪 Cancel & rebook upgrade policy\n');
  try {
    policyChecks();
    // Psycle now swaps in place (atomicSwap); these checks exercise the cancel-then-rebook path, so model a gym without a swap API.
    const _swapCaps = require('./gyms.config').getGymConfig('psycle-london').capabilities;
    const _prevSwap = _swapCaps.atomicSwap;
    const _prevCr = _swapCaps.cancelRebookUpgrade;
    _swapCaps.atomicSwap = false; _swapCaps.cancelRebookUpgrade = true; // model a gym that still cancels and rebooks
    try { await engineChecks(require("./poller")); } finally { _swapCaps.atomicSwap = _prevSwap; _swapCaps.cancelRebookUpgrade = _prevCr; }
    console.log('\n🎉 CANCEL & REBOOK CHECKS PASSED.\n');
  } catch (err) { failed = 1; console.error('\n❌ FAILED:\n', err, '\n'); }
  finally { for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) { try { fs.unlinkSync(f); } catch (_) {} } }
  process.exit(failed);
})();
