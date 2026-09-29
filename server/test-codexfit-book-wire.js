// U1-19 — the POST /bookings wire shape. Normalized ids are strings, but CodexFit
// (and prod `master`) send NUMERIC event_id/slots. The adapter converts at the
// boundary; the dev mock rejects the string shape with 422 so it cannot hide a
// regression. Also pins that a 422 with `errors` but no `message` surfaces the reason.
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const assert = require('assert');
const { getProvider } = require('./providers');
const CodexFitProvider = require('./providers/codexfit');
const { handleMockRequest, NO_LAYOUT_EVENT_ID, NO_LAYOUT_FULL_EVENT_ID } = require('./mock');

const provider = getProvider('psycle-london');
const fakeRes = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body, headers: { get: () => null } });

async function withStub(impl, fn) {
  const original = CodexFitProvider.prototype.request;
  CodexFitProvider.prototype.request = impl;
  const warn = console.warn; console.warn = () => {};
  try { return await fn(); } finally { CodexFitProvider.prototype.request = original; console.warn = warn; }
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('bookSlot sends numeric event_id and slots (master wire shape)', async () => {
  let sent;
  await withStub(async (p, opts) => { sent = { p, ...opts }; return fakeRes({ success: true, bookings: { 1: 17 } }); },
    () => provider.bookSlot('205627', ['17'], { accessToken: 't' }));
  assert.strictEqual(sent.p, '/bookings');
  assert.deepStrictEqual(sent.body, { event_id: 205627, slots: [17] });
});

check('no-seat-map class (no slot given): resolves an available slot from GET /events/{id}.slots, never POSTs without one', async () => {
  const posts = [];
  await withStub(async (p, opts = {}) => {
    if (opts.method === 'POST') { posts.push(opts.body); return fakeRes({ success: true, bookings: { 9: 1 } }); }
    return fakeRes({ data: { id: 216718, studio_id: 71 }, slots: [1, 4, 8], relations: {} });
  }, () => provider.bookSlot('216718', [], { accessToken: 't' }));
  assert.deepStrictEqual(posts, [{ event_id: 216718, slots: [1] }]);
});

check('no-seat-map class with no available slots reports full (client then offers the waitlist)', async () => {
  let posted = false;
  const r = await withStub(async (p, opts = {}) => {
    if (opts.method === 'POST') { posted = true; return fakeRes({ success: true }); }
    return fakeRes({ data: {}, slots: [], relations: {} });
  }, () => provider.bookSlot('216718', [], { accessToken: 't' }));
  assert.strictEqual(r.ok, false);
  assert.ok(/full|no availab/i.test(r.error), r.error);
  assert.strictEqual(posted, false);
});

check('no-seat-map: falls to the next slot when the first is taken', async () => {
  const tried = [];
  const r = await withStub(async (p, opts = {}) => {
    if (opts.method === 'POST') {
      tried.push(opts.body.slots[0]);
      return tried.length === 1 ? fakeRes({ message: 'Slot taken' }, { ok: false, status: 422 }) : fakeRes({ success: true, bookings: { 5: opts.body.slots[0] } });
    }
    return fakeRes({ data: {}, slots: [1, 4, 8], relations: {} });
  }, () => provider.bookSlot('1', [], { accessToken: 't' }));
  assert.deepStrictEqual(tried, [1, 4]);
  assert.strictEqual(r.ok, true);
});

check('a 422 with errors but no message surfaces the reason, not "HTTP 422"', async () => {
  const r = await withStub(async () => fakeRes({ errors: { slots: ['The slots.0 field is invalid.'] } }, { ok: false, status: 422 }),
    () => provider.bookSlot('1', ['2'], { accessToken: 't' }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'The slots.0 field is invalid.');
});

check('mock POST /bookings rejects string ids and a missing slot with 422', async () => {
  assert.strictEqual((await handleMockRequest('/bookings', 'POST', { event_id: '1000', slots: ['3'] })).status, 422);
  assert.strictEqual((await handleMockRequest('/bookings', 'POST', { event_id: 1000 })).status, 422);
  assert.strictEqual((await handleMockRequest('/bookings', 'POST', { event_id: 1000, slots: [] })).status, 422);
});

check('end to end vs the mock: seat-map class and no-seat-map class both book; a full no-map class is refused', async () => {
  const S = { accessToken: 'mock-jwt-token' };
  const a = await provider.bookSlot('1000', ['3'], S);
  assert.strictEqual(a.ok, true, JSON.stringify(a));
  const b = await provider.bookSlot(String(NO_LAYOUT_EVENT_ID), [], S);
  assert.strictEqual(b.ok, true, JSON.stringify(b));
  const c = await provider.bookSlot(String(NO_LAYOUT_FULL_EVENT_ID), [], S);
  assert.strictEqual(c.ok, false);
  await provider.cancelBooking(a.bookingId, S);
  await provider.cancelBooking(b.bookingId, S);
});

(async () => {
  let failed = 0, passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`✅ ${name}`); passed++; } catch (e) { failed++; console.error(`❌ ${name}\n   ${e.stack || e.message}`); }
  }
  console.log(`\n${failed ? '⚠️ ' : '🎉'} ${passed}/${checks.length} book-wire checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed ? 1 : 0);
})();
