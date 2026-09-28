// Sweat Assistant — C2-7 regression: CodexFit `/profile` envelope.
//
// The live `GET /api/v1/customer/profile` wraps the profile in `{ data: {...} }`
// (server/fixtures/codexfit-v2/PARITY.md G1, profile-v1-response.json). Before
// this fix, codexfit.js's getProfile/getEligibility/getCredits read fields
// straight off the top-level JSON body, so every field was silently undefined
// against the real gym — live 2 real credits reported as 0, every Psycle row
// showed "Buy Credits". Invisible to every other suite because server/mock.js's
// dev fixture returned the profile bare, not enveloped.
//
// This test is fixture-driven against the actual sanitized live capture, so it
// fails today (pre-fix) for the reason recorded above, and asserts BOTH shapes
// (enveloped and bare) keep working — a future upstream envelope flip must not
// silently zero credits again.
//
// Convention: plain-Node assertions, matching test-adapters.js. Run directly:
//   node server/test-profile-envelope.js

if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { getProvider } = require('./providers');

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'codexfit-v2', 'profile-v1-response.json');
const LIVE_FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
// The fixture wraps the actual HTTP response body one level further under its
// own `response` key for documentation purposes — `.response` IS the JSON body
// `GET /profile` returns, i.e. already `{ data: {...} }`.
const LIVE_BODY = LIVE_FIXTURE.response;

const fakeRes = (body, { ok = true, status = 200 } = {}) => ({
  ok, status, json: async () => body,
});

async function withStub(obj, method, impl, fn) {
  const original = obj[method];
  obj[method] = impl;
  // C2-6: every check reuses token 'tok' with a different body; drop the
  // /profile memo so each check sees its own stubbed response.
  if (typeof obj.invalidateProfile === 'function') obj.invalidateProfile({ accessToken: 'tok' });
  try { return await fn(); }
  finally { obj[method] = original; }
}

let passed = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// --- Enveloped (live-shaped) responses --------------------------------------

check('getProfile unwraps the live { data: {...} } envelope', async () => {
  const cf = getProvider('psycle-london');
  const profile = await withStub(cf, 'request', async () => fakeRes(LIVE_BODY), () => cf.getProfile({ accessToken: 'tok' }));
  assert.strictEqual(profile.id, '52155', 'id read from the unwrapped data');
  assert.strictEqual(profile.bookingCutoff, '2026-10-06T00:00:00', 'booking_cutoff unwrapped');
  assert.strictEqual(profile.extendedCutoff, '2026-10-06T00:00:00', 'extended_cutoff unwrapped');
  assert.ok(profile.raw && profile.raw.id === 52155, 'raw is the unwrapped profile object, not the envelope');
  assert.ok(Array.isArray(profile.raw.available_credits), 'raw.available_credits reachable (client reads profile.raw.X)');
});

check('getEligibility reads real credits through the envelope (live: 2 credits, canBook true)', async () => {
  const cf = getProvider('psycle-london');
  const eligibility = await withStub(cf, 'request', async () => fakeRes(LIVE_BODY), () => cf.getEligibility({ accessToken: 'tok' }));
  assert.strictEqual(eligibility.canBook, true, 'the live fixture has 2 usable credits — must not read as 0');
});

check('getCredits maps the enveloped available_credits array, not an empty top-level miss', async () => {
  const cf = getProvider('psycle-london');
  const credits = await withStub(cf, 'request', async () => fakeRes(LIVE_BODY), () => cf.getCredits({ accessToken: 'tok' }));
  assert.strictEqual(credits.length, 1, 'one credit-type entry in the live fixture');
  assert.strictEqual(credits[0].count, 2, 'count read from the unwrapped entry');
  assert.strictEqual(credits[0].typeName, 'Universal');
});

check('resolveBookingWindow resolves a real window from the enveloped profile.raw', async () => {
  const cf = getProvider('psycle-london');
  const profile = await withStub(cf, 'request', async () => fakeRes(LIVE_BODY), () => cf.getProfile({ accessToken: 'tok' }));
  const win = cf.resolveBookingWindow(profile.raw, []);
  assert.ok(win, 'a cutoff-bearing profile must resolve a window, not null');
  assert.strictEqual(typeof win.offsetDays, 'number');
});

// --- Bare (mock-shaped) responses still work --------------------------------

check('getProfile still works when the body is already bare (accepts either shape)', async () => {
  const cf = getProvider('psycle-london');
  const bare = { id: 42, email: 'a@b.com', first_name: 'Sam', last_name: 'Doe', booking_cutoff: '2026-07-10T12:00:00Z', extended_cutoff: '2026-07-17T12:00:00Z', available_credits: [{ count: 5, credit_type: { id: 1, name: 'Universal' } }] };
  const profile = await withStub(cf, 'request', async () => fakeRes(bare), () => cf.getProfile({ accessToken: 'tok' }));
  assert.strictEqual(profile.id, '42');
  assert.strictEqual(profile.bookingCutoff, '2026-07-10T12:00:00Z');
});

check('getEligibility still works when the body is already bare', async () => {
  const cf = getProvider('psycle-london');
  const bare = { available_credits: [{ count: 3, credit_type: { id: 1, name: 'Universal' } }] };
  const eligibility = await withStub(cf, 'request', async () => fakeRes(bare), () => cf.getEligibility({ accessToken: 'tok' }));
  assert.strictEqual(eligibility.canBook, true);
});

check('a genuinely credit-less bare profile still reports canBook: false (no false positive)', async () => {
  const cf = getProvider('psycle-london');
  const bare = { id: 1, available_credits: [] };
  const eligibility = await withStub(cf, 'request', async () => fakeRes(bare), () => cf.getEligibility({ accessToken: 'tok' }));
  assert.strictEqual(eligibility.canBook, false);
});

(async () => {
  console.log('\n🧪 CodexFit /profile envelope tests (C2-7)\n');
  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`❌ ${name}\n   ${err.message}`);
    }
  }
  console.log(`\n${failed === 0 ? '🎉' : '⚠️ '} ${passed}/${checks.length} profile-envelope checks passed.${failed ? ` ${failed} FAILED.` : ''}\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
