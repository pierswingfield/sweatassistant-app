// CodexFit direct spot swap: PATCH {v2}/bookings/{id} {slot} (live capture 2026-10-11).
//
// Pins: the happy path is ONE PATCH (no cancel, no rebook); a refused swap
// (slot taken, throttled) is a failure that never falls back to
// cancel-then-rebook (that is how a member loses their spot); the fallback runs
// only when the endpoint itself is missing; the dev mock honours the same
// contract end to end.
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MOCK_BOOKINGS_PATH = require('path').join(require('os').tmpdir(), `swap-mock-${process.pid}.dbjson`);

const assert = require('assert');
const { getProvider } = require('./providers');
const CodexFitProvider = require('./providers/codexfit');
const { GYMS } = require('./gyms.config');

const provider = getProvider('psycle-london');
const session = { accessToken: 'real-looking-token' };
const fakeRes = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body, headers: { get: () => null } });

async function stubbed(v2, v1, fn) {
  const o2 = CodexFitProvider.prototype.requestV2;
  const o1 = CodexFitProvider.prototype.request;
  CodexFitProvider.prototype.requestV2 = v2;
  CodexFitProvider.prototype.request = v1;
  try { return await fn(); } finally { CodexFitProvider.prototype.requestV2 = o2; CodexFitProvider.prototype.request = o1; }
}

(async () => {
  assert.strictEqual(GYMS['psycle-london'].capabilities.atomicSwap, true, 'Psycle declares the native swap');

  // 1. Happy path: exactly one PATCH, numeric slot, v2 path; nothing else is called.
  {
    const calls = [];
    const r = await stubbed(
      async (path, o) => { calls.push({ path, method: o.method, body: o.body }); return fakeRes({ success: true, slot: 9 }); },
      async (path, o) => { calls.push({ v1: true, path, method: o.method }); return fakeRes({}); },
      () => provider.swapSpots('8589475', '5', '9', session),
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(String(r.bookingId), '8589475', 'booking id is unchanged by a swap');
    assert.strictEqual(String(r.slotId), '9');
    assert.deepStrictEqual(calls, [{ path: '/bookings/8589475', method: 'PATCH', body: { slot: 9 } }]);
    console.log('✅ swap = one v2 PATCH {slot:9}, no cancel/rebook, booking id preserved.');
  }

  // 2. Refused swap never falls back.
  for (const status of [422, 409, 403, 500]) {
    const calls = [];
    const r = await stubbed(
      async (path, o) => { calls.push(`${o.method} ${path}`); return fakeRes({ message: 'That spot is no longer available.' }, { ok: false, status }); },
      async (path, o) => { calls.push(`v1 ${o.method || 'GET'} ${path}`); return fakeRes({}); },
      () => provider.swapSpots('1', '5', '9', session),
    );
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, status);
    assert.deepStrictEqual(calls, ['PATCH /bookings/1'], `HTTP ${status} must not cancel anything`);
  }
  console.log('✅ 422/409/403/500 are failures with no cancel-then-rebook fallback.');

  // 3. A 429 is classified so callers back off.
  {
    const r = await stubbed(async () => fakeRes({}, { ok: false, status: 429 }), async () => fakeRes({}), () => provider.swapSpots('1', '5', '9', session));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'PROVIDER_RATE_LIMITED');
    console.log('✅ 429 -> PROVIDER_RATE_LIMITED.');
  }

  // 4. Endpoint missing -> fallback to cancel-then-rebook (404 and the old BadMethodCall 500).
  for (const [status, body] of [[404, {}], [405, {}], [500, { exception: 'BadMethodCallException' }]]) {
    const calls = [];
    const r = await stubbed(
      async (path, o) => { calls.push(`${o.method} ${path}`); return fakeRes(body, { ok: false, status }); },
      async (path, o = {}) => {
        const m = o.method || 'GET';
        calls.push(`v1 ${m} ${path}`);
        if (path.startsWith('/bookings?')) return fakeRes({ data: [{ id: 1, event: { id: 11 } }] });
        if (m === 'DELETE') return fakeRes({ success: true });
        if (m === 'POST') return fakeRes({ success: true, bookings: { 77: 9 } });
        return fakeRes({});
      },
      () => provider.swapSpots('1', '5', '9', session),
    );
    assert.strictEqual(r.ok, true, `fallback after ${status}`);
    assert.ok(calls.some((c) => c === 'v1 DELETE /bookings/1') && calls.some((c) => c === 'v1 POST /bookings'), `fallback ran after ${status}`);
  }
  console.log('✅ missing endpoint (404/405/BadMethodCall 500) falls back to cancel-then-rebook.');

  // An MCP/shared-app atomic-only request must never use the legacy fallback.
  for (const [status, body] of [[404, {}], [405, {}], [501, {}], [500, { exception: 'BadMethodCallException' }]]) {
    const calls = [];
    const r = await stubbed(
      async (path, o) => { calls.push(`${o.method} ${path}`); return fakeRes(body, { ok: false, status }); },
      async () => { calls.push('UNSAFE_FALLBACK'); return fakeRes({}); },
      () => provider.swapSpots('1', '5', '9', session, { allowCancelRebook: false }),
    );
    assert.strictEqual(r.ok, false, 'atomic-only missing endpoint is a refusal');
    assert.strictEqual(r.code, 'ATOMIC_SWAP_UNAVAILABLE');
    assert.deepStrictEqual(calls, ['PATCH /bookings/1'], 'atomic-only swap never cancels or books');
  }

  // 5. End to end against the dev mock: same booking id, new slot, taken slot refused.
  {
    const { MOCK_TOKEN } = require('./providers/codexfit');
    const mockSession = { accessToken: provider.mockToken || MOCK_TOKEN };
    const a = await provider.bookSlot('1000', ['21'], mockSession);
    assert.ok(a.ok, 'mock booking A');
    const b = await provider.bookSlot('1000', ['22'], mockSession);
    assert.ok(b.ok, 'mock booking B');

    const moved = await provider.swapSpots(a.bookingId, '21', '33', mockSession);
    assert.strictEqual(moved.ok, true);
    let list = await (await provider.request('/bookings', { token: mockSession.accessToken })).json();
    const row = list.find((x) => String(x.id) === String(a.bookingId));
    assert.ok(row, 'same booking id still exists after the swap');
    assert.strictEqual(row.studio_slot.id, 33);

    const refused = await provider.swapSpots(a.bookingId, '33', '22', mockSession);
    assert.strictEqual(refused.ok, false, 'a taken spot is refused');
    list = await (await provider.request('/bookings', { token: mockSession.accessToken })).json();
    assert.ok(list.find((x) => String(x.id) === String(a.bookingId)), 'refused swap leaves the booking in place');
    console.log('✅ mock: in-place move keeps the id; taken spot refused without losing the booking.');
  }
})().catch((e) => { console.error(e); process.exit(1); });
