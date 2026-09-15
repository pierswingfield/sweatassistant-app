// Capability-driven behaviour (WP-D14).
//
// Capability flags existed and were correct in gyms.config.js for weeks while
// NOTHING read them — the UI rendered Buy Credits and Bookmarks for every gym,
// and the poller cancel-then-rebooked on a platform with a native atomic swap.
// A flag nothing consults is documentation, not behaviour.
//
// These pin the SERVER half: that the flags are served to the client, and that
// the upgrade path actually branches on `atomicSwap`. The client half (hiding
// tabs, per-gym theming) is covered by client/src/*.test.js and the browser
// smoke test — see Documentation/TESTING.md.

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = process.env.DB_PATH || ':memory:';

const assert = require('assert');
const { GYMS } = require('./gyms.config');
const { getProvider } = require('./providers');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- 1. the flags describe each platform truthfully -------------------------

check('the flags match what each platform can actually do', () => {
  const psycle = GYMS['psycle-london'].capabilities;
  const jab = GYMS['jab-boxing'].capabilities;

  // CodexFit has no spot-swap API — GET/PUT /bookings/{id} return HTTP 500
  // (BadMethodCallException), confirmed by authenticated testing. So upgrades
  // there MUST be cancel-then-rebook, and the flag has to say so.
  assert.strictEqual(psycle.atomicSwap, false);
  assert.strictEqual(typeof getProvider('psycle-london').swapSpots, 'function',
    'the method still exists — it just cancel-then-rebooks underneath');

  // MarianaTek has POST /reservations/{id}/swap_spots.
  assert.strictEqual(jab.atomicSwap, true);
  assert.strictEqual(jab.bookmarks, false, 'no bookmarks API on MarianaTek');
  assert.strictEqual(jab.creditPurchase, false, 'membership-based, no confirmed purchase API');
  assert.strictEqual(jab.metered, false, 'classes do not draw down a credit balance');
});

check('metered and creditPurchase are separate questions', () => {
  // A gym could meter classes without us being able to sell top-ups in-app.
  // Collapsing them means an unmetered gym gets credit arithmetic applied to it,
  // which resolves to 0 and disables booking outright.
  for (const gym of Object.values(GYMS)) {
    assert.notStrictEqual(gym.capabilities.metered, undefined, `${gym.id}: metered undeclared`);
    assert.notStrictEqual(gym.capabilities.creditPurchase, undefined, `${gym.id}: creditPurchase undeclared`);
  }
});

// --- 2. the flags reach the client ------------------------------------------

check('GET /api/gyms serves capabilities, theme and labels', () => {
  // The client cannot gate on what it is not told. This mirrors the route's
  // projection rather than importing it, so dropping a field from the response
  // shows up here.
  const projected = Object.values(GYMS).map((g) => ({
    id: g.id, name: g.name, websiteUrl: g.websiteUrl, provider: g.provider, enabled: g.enabled,
    theme: g.theme, labels: g.labels, capabilities: g.capabilities,
  }));
  for (const g of projected) {
    assert.ok(g.capabilities && Object.keys(g.capabilities).length >= 5, `${g.id}: capabilities missing`);
    assert.ok(g.theme && g.theme.primary, `${g.id}: no theme colour for the UI to brand with`);
    assert.ok(g.labels && g.labels.spot, `${g.id}: no spot noun`);
    assert.ok(/^https:\/\//.test(g.websiteUrl), `${g.id}: no public website URL`);
  }
});

check('a gym is still described, so it can be listed', () => {
  const jab = Object.values(GYMS).find((g) => g.id === 'jab-boxing');
  assert.strictEqual(typeof jab.enabled, 'boolean');
  assert.ok(jab.capabilities, 'a gym still describes itself');
});

// --- 3. the upgrade path branches on the flag -------------------------------

check('the poller reaches for an atomic swap only where one exists', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'poller.js'), 'utf8');

  assert.ok(/capabilities\s*&&\s*gym\.capabilities\.atomicSwap/.test(src),
    'the upgrade path must consult capabilities.atomicSwap, not the gym id');
  assert.ok(/swapSpotsWithRelogin/.test(src),
    'and call the swap through the same relogin ladder as booking');

  // The dangerous half: after an atomic swap there is no second booking to
  // cancel, and cancelling anyway would cancel the upgrade itself.
  assert.ok(/!usedAtomicSwap\s*&&\s*!isCutoffMode/.test(src),
    'the cancel-the-original step must be skipped when a swap already moved it');

  assert.ok(!/['"]jab-boxing['"]/.test(src) && !/['"]psycle-london['"]/.test(src),
    'and none of this may branch on a gym id');
});

check('both providers implement swapSpots, so the caller never needs to know', () => {
  for (const id of Object.keys(GYMS)) {
    assert.strictEqual(typeof getProvider(id).swapSpots, 'function',
      `${id} must implement swapSpots — the capability flag chooses the STRATEGY, ` +
      'but the method has to exist either way or the call site needs a gym check');
  }
});

// --- run --------------------------------------------------------------------

let passed = 0;
const failures = [];
for (const { name, fn } of checks) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}
console.log('');
if (failures.length) {
  console.error(`✗ ${failures.length}/${checks.length} capability-gating checks FAILED.`);
  process.exit(1);
}
console.log(`🎉 ${passed}/${checks.length} capability-gating checks passed.`);
