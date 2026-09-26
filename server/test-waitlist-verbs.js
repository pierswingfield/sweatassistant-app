// C2-2 — waitlist join/leave verb + id contract.
//
// Confirms two things against providers/codexfit.js:
//   1. Join uses PUT /waitlists/{eventId} (the doc's POST claim was wrong —
//      C2-G2, resolved; the code was already right).
//   2. Leave targets the WAITLIST ROW id, not the event id (C2-2 fix,
//      2026-09-26). Root cause: a live capture
//      (server/fixtures/codexfit-v2/waitlist-v1-join-leave.json, PARITY.md G2)
//      showed the real site's leave call is DELETE /waitlists/{row id from the
//      join response}, never DELETE /waitlists/{event id} — which is what this
//      method used to call directly. The fix keeps the shared eventId-based
//      interface (base.js) by resolving the row internally via listWaitlists(),
//      the same pattern MarianaTek's leaveWaitlist already uses for its own,
//      differently-shaped id mismatch.
//
// Also exercises the fixed mock.js waitlist handlers end to end (join →
// confirm it's the only route to a "Leave" state → leave → confirm removed),
// since C2-2's browser verification runs against dev mode.

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { getProvider } = require('./providers');
const CodexFitProvider = require('./providers/codexfit');

const provider = getProvider('psycle-london');
const MOCK_SESSION = { accessToken: 'mock-jwt-token' };

const fakeRes = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body,
});

async function withStub(impl, fn) {
  const original = CodexFitProvider.prototype.request;
  CodexFitProvider.prototype.request = impl;
  try { return await fn(); }
  finally { CodexFitProvider.prototype.request = original; }
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
let passed = 0;

check('joinWaitlist: PUT /waitlists/{eventId}', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    return fakeRes({ success: true, waitlist: { id: 300480, event_id: 217095 } });
  }, async () => {
    const ok = await provider.joinWaitlist('217095', { accessToken: 'real-token' });
    assert.strictEqual(ok, true);
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].pathOrUrl, '/waitlists/217095', 'targets the EVENT id');
  assert.strictEqual(calls[0].method, 'PUT', 'join verb is PUT, not POST (C2-G2)');
});

check('leaveWaitlist: resolves the waitlist ROW id via listWaitlists(), then DELETEs by that id — NOT the event id', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    if (pathOrUrl.startsWith('/waitlists?')) {
      // listWaitlists() read: one active entry for event 217095, row id 300480.
      return fakeRes({
        data: [
          {
            id: 300480,
            event_id: 217095,
            cancelled_at: null,
            event: { id: 217095, start_at: '2026-09-28T17:30:00', duration: 55 },
          },
        ],
      });
    }
    return fakeRes({ success: true });
  }, async () => {
    const ok = await provider.leaveWaitlist('217095', { accessToken: 'real-token' });
    assert.strictEqual(ok, true);
  });
  const deleteCall = calls.find((c) => c.method === 'DELETE');
  assert.ok(deleteCall, 'a DELETE call was made');
  assert.strictEqual(deleteCall.pathOrUrl, '/waitlists/300480', 'DELETEs the waitlist ROW id (300480), not the event id (217095) — this is the C2-2 bug');
});

check('leaveWaitlist: no matching waitlist entry for the event → no DELETE, returns false', async () => {
  const calls = [];
  await withStub(async function (pathOrUrl, opts) {
    calls.push({ pathOrUrl, ...opts });
    return fakeRes({ data: [] }); // no active waitlist entries at all
  }, async () => {
    const ok = await provider.leaveWaitlist('999999', { accessToken: 'real-token' });
    assert.strictEqual(ok, false);
  });
  assert.ok(!calls.some((c) => c.method === 'DELETE'), 'never DELETEs when there is nothing to leave');
});

// --- Mock round-trip (what the browser check exercises in dev mode) --------

check('mock: join then leave by event id removes exactly that entry (row-id resolution works end to end)', async () => {
  const joinOk = await provider.joinWaitlist('4242', MOCK_SESSION);
  assert.strictEqual(joinOk, true);

  const listed = await provider.listWaitlists(MOCK_SESSION);
  const entry = listed.find((w) => w.eventId === '4242');
  assert.ok(entry, 'the joined entry appears in listWaitlists()');
  assert.ok(entry.bookingId, 'the row id (bookingId) is present — this is what leave must target');

  const leaveOk = await provider.leaveWaitlist('4242', MOCK_SESSION);
  assert.strictEqual(leaveOk, true);

  const after = await provider.listWaitlists(MOCK_SESSION);
  assert.ok(!after.some((w) => w.eventId === '4242'), 'entry is gone after leaving');
});

check('mock: DELETE /waitlists/{eventId} (the old, wrong target) does not remove the real row', async () => {
  // Regression guard for the exact bug: hitting the mock directly with the
  // EVENT id (simulating the pre-fix code path) must be a no-op, not a
  // coincidental success — proving the row id and event id are genuinely
  // different keys in this mock, same as live.
  const { handleMockRequest } = require('./mock');
  await provider.joinWaitlist('5151', MOCK_SESSION);
  const listed = await provider.listWaitlists(MOCK_SESSION);
  const entry = listed.find((w) => w.eventId === '5151');
  assert.ok(entry && entry.bookingId !== '5151', 'row id differs from event id in the mock, same as live');

  await handleMockRequest(`/waitlists/5151`, 'DELETE'); // wrong id, direct hit
  const stillThere = await provider.listWaitlists(MOCK_SESSION);
  assert.ok(stillThere.some((w) => w.eventId === '5151'), 'entry survives a DELETE using the wrong (event) id');

  // Clean up using the correct id so this suite leaves no mock state behind.
  await provider.leaveWaitlist('5151', MOCK_SESSION);
});

(async () => {
  console.log('\n🧪 Waitlist join/leave verb + id tests (C2-2)\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`❌ ${name}\n   ${err.stack || err.message}`);
    }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} waitlist checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
