// C2-6 — single-flight + short memo for CodexFit GET /profile.
//
// Root cause: getProfile, getEligibility and getCredits each called
// `this.request('/profile', ...)` independently, so one page load (profile +
// eligibility + credits) or one scheduler/poller pass cost three upstream
// fetches of the same document, and N concurrent readers cost N.
//
// Contract pinned here:
//   - N concurrent callers (any mix of the three methods) -> 1 upstream fetch
//   - the memo is keyed by gym + session token: two users -> two fetches
//   - a write that changes credits/profile (book, cancel, swap, finalise,
//     updateProfile) invalidates that user's entry
//   - failures are never cached (and never poison the in-flight slot)
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');
const { getProvider } = require('./providers');
const CodexFitProvider = require('./providers/codexfit');

const provider = getProvider('psycle-london');
const profileBody = { data: { id: 7, email: 'a@b.c', first_name: 'A', last_name: 'B', available_credits: [{ count: 3, credit_type: { id: 1, name: 'Ride' } }] } };
const fakeRes = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });

async function withStub(impl, fn) {
  const original = CodexFitProvider.prototype.request;
  CodexFitProvider.prototype.request = impl;
  try { return await fn(); } finally { CodexFitProvider.prototype.request = original; }
}
// Counts /profile fetches; every other path answers a benign success.
function counting(state) {
  return async function (path, opts = {}) {
    if (path === '/profile') {
      state.profile++;
      await new Promise((r) => setTimeout(r, 15));
      return state.fail ? fakeRes({}, { ok: false, status: 429 }) : fakeRes(profileBody);
    }
    state.other.push(`${opts.method || 'GET'} ${path}`);
    if (path.startsWith('/bookings?')) return fakeRes({ data: [{ id: 5, event: { id: 11 } }] });
    if (path === '/bookings' && opts.method === 'POST') return fakeRes({ success: true, bookings: { 99: 5 } });
    return fakeRes({ success: true });
  };
}

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check('10 concurrent mixed callers -> exactly 1 upstream /profile fetch', async () => {
  const s = { profile: 0, other: [] }; const sess = { accessToken: 'tok-concurrent' };
  await withStub(counting(s), async () => {
    const calls = [];
    for (let i = 0; i < 4; i++) calls.push(provider.getProfile(sess), provider.getEligibility(sess), provider.getCredits(sess));
    const out = await Promise.all(calls);
    assert.strictEqual(out[0].id, '7');
    assert.strictEqual(out[2][0].count, 3);
  });
  assert.strictEqual(s.profile, 1);
});

check('memo serves a follow-up call inside the TTL without refetching', async () => {
  const s = { profile: 0, other: [] }; const sess = { accessToken: 'tok-memo' };
  await withStub(counting(s), async () => {
    await provider.getProfile(sess); await provider.getCredits(sess); await provider.getEligibility(sess);
  });
  assert.strictEqual(s.profile, 1);
});

check('two users (different tokens) -> two fetches, never shared', async () => {
  const s = { profile: 0, other: [] };
  await withStub(counting(s), async () => {
    await Promise.all([provider.getProfile({ accessToken: 'user-A' }), provider.getProfile({ accessToken: 'user-B' })]);
  });
  assert.strictEqual(s.profile, 2);
});

check('a booking invalidates the memo (credits changed)', async () => {
  const s = { profile: 0, other: [] }; const sess = { accessToken: 'tok-book' };
  await withStub(counting(s), async () => {
    await provider.getCredits(sess);
    await provider.bookSlot('1', [2], sess);
    await provider.getCredits(sess);
  });
  assert.strictEqual(s.profile, 2);
});

check('cancel, updateProfile and swap invalidate too', async () => {
  for (const [label, write] of [
    ['cancel', (sess) => provider.cancelBooking('5', sess)],
    ['updateProfile', (sess) => provider.updateProfile({ first_name: 'x' }, sess)],
    ['swap', (sess) => provider.swapSpots('5', 1, 2, sess).catch(() => {})],
  ]) {
    const s = { profile: 0, other: [] }; const sess = { accessToken: `tok-${label}` };
    await withStub(counting(s), async () => {
      await provider.getProfile(sess);
      await write(sess);
      await provider.getProfile(sess);
    });
    assert.strictEqual(s.profile, 2, `${label} must invalidate`);
  }
});

check('a write that lands mid-flight is not overwritten by the stale in-flight result', async () => {
  const s = { profile: 0, other: [] }; const sess = { accessToken: 'tok-race' };
  await withStub(counting(s), async () => {
    const inflight = provider.getProfile(sess);
    await provider.cancelBooking('5', sess);
    await inflight;
    await provider.getProfile(sess); // must refetch: the first result predates the write
  });
  assert.strictEqual(s.profile, 2);
});

check('failed responses are not cached and do not poison later calls', async () => {
  const s = { profile: 0, other: [], fail: true }; const sess = { accessToken: 'tok-fail' };
  await withStub(counting(s), async () => {
    await assert.rejects(provider.getProfile(sess), (e) => e.status === 429);
    await assert.rejects(provider.getCredits(sess), (e) => e.status === 429);
    s.fail = false;
    const p = await provider.getProfile(sess);
    assert.ok(p);
  });
  assert.strictEqual(s.profile, 3);
});

(async () => {
  console.log('\n🧪 /profile single-flight (C2-6)\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
  }
  if (failed) { console.error(`\n✗ ${failed}/${checks.length} failed`); process.exit(1); }
  console.log(`\n🎉 ${checks.length}/${checks.length} passed`);
})();
