// Shared schedule cache semantics (2026-09-14).
//
// This cache exists because the timetable was slow on the SECOND load, not just
// the first — nothing cached a gym's schedule server-side, so every user's
// every visit paid a full provider round trip for data identical to what the
// last visitor just fetched.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const cache = require('./schedule-cache');

let passed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('a second read for the same key does NOT call the provider again', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return [{ id: 'a' }]; };
  const key = `t|gym|${Math.random()}`;
  await cache.getOrFetch(key, fetcher, { ttlMs: 10000 });
  await cache.getOrFetch(key, fetcher, { ttlMs: 10000 });
  await cache.getOrFetch(key, fetcher, { ttlMs: 10000 });
  assert.strictEqual(calls, 1, 'one provider call serves every subsequent read');
});

check('concurrent cold reads share ONE provider call (single-flight)', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; await sleep(30); return [{ id: 'b' }]; };
  const key = `t|gym|${Math.random()}`;
  // The release-instant case: many users ask for the same day at the same
  // second. Without single-flight that is N identical provider calls, which is
  // both slow and the fastest way to get rate limited by the gym.
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.getOrFetch(key, fetcher, { ttlMs: 10000 })));
  assert.strictEqual(calls, 1, '8 concurrent callers → 1 provider call');
  results.forEach((r) => assert.deepStrictEqual(r, [{ id: 'b' }]));
});

check('a stale entry is served immediately and refreshed behind the request', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return [{ id: `v${calls}` }]; };
  const key = `t|gym|${Math.random()}`;

  const first = await cache.getOrFetch(key, fetcher, { ttlMs: 20 });
  assert.deepStrictEqual(first, [{ id: 'v1' }]);
  await sleep(40); // now stale

  const second = await cache.getOrFetch(key, fetcher, { ttlMs: 20 });
  // Stale-while-revalidate: the READER never waits for the provider.
  assert.deepStrictEqual(second, [{ id: 'v1' }], 'stale value returned immediately');

  await sleep(40); // background refresh lands
  const third = await cache.getOrFetch(key, fetcher, { ttlMs: 20000 });
  assert.deepStrictEqual(third, [{ id: 'v2' }], 'and the refreshed value is there next time');
});

check('a failed refresh keeps the last good value instead of emptying the page', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    if (calls === 1) return [{ id: 'good' }];
    throw new Error('provider down');
  };
  const key = `t|gym|${Math.random()}`;
  await cache.getOrFetch(key, fetcher, { ttlMs: 20 });
  await sleep(40);
  // Serves stale, kicks a refresh that will fail.
  const served = await cache.getOrFetch(key, fetcher, { ttlMs: 20 });
  assert.deepStrictEqual(served, [{ id: 'good' }]);
  await sleep(30);
  const afterFailure = await cache.getOrFetch(key, fetcher, { ttlMs: 20 });
  assert.deepStrictEqual(afterFailure, [{ id: 'good' }],
    'a provider blip must not turn into an empty timetable for everyone');
});

check('force bypasses the cache — what the refresh button needs', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return [{ id: `v${calls}` }]; };
  const key = `t|gym|${Math.random()}`;
  await cache.getOrFetch(key, fetcher, { ttlMs: 10000 });
  const forced = await cache.getOrFetch(key, fetcher, { ttlMs: 10000, force: true });
  assert.strictEqual(calls, 2);
  assert.deepStrictEqual(forced, [{ id: 'v2' }]);
});

check('createCache: own counters, maxStaleMs forces refetch but stale-if-error serves last good', async () => {
  const c = cache.createCache();
  const key = 'layout|psycle-london|1';
  await c.getOrFetch(key, async () => ['v1'], { ttlMs: 5, maxStaleMs: 20 });
  await sleep(40); // past ttl + maxStale
  let calls = 0;
  const v = await c.getOrFetch(key, async () => { calls++; throw new Error('provider down'); }, { ttlMs: 5, maxStaleMs: 20 });
  assert.strictEqual(calls, 1, 'too-old entry awaits the provider');
  assert.deepStrictEqual(v, ['v1'], 'provider failure falls back to last good value');
  // gym id in the key keeps two gyms' studio 1 apart
  await c.getOrFetch('layout|jab-boxing|1', async () => ['jab'], { ttlMs: 10000 });
  assert.deepStrictEqual(await c.getOrFetch('layout|jab-boxing|1', async () => ['x'], { ttlMs: 10000 }), ['jab']);
});

check('invalidate drops one gym and leaves the other alone', async () => {
  const fetcher = async () => [{ id: 'x' }];
  await cache.getOrFetch('timetable|gym-a|d1|d2', fetcher, { ttlMs: 10000 });
  await cache.getOrFetch('timetable|gym-b|d1|d2', fetcher, { ttlMs: 10000 });
  const dropped = cache.invalidate('timetable|gym-a|');
  assert.strictEqual(dropped, 1, 'only gym-a is dropped');

  let aCalls = 0;
  await cache.getOrFetch('timetable|gym-a|d1|d2', async () => { aCalls++; return []; }, { ttlMs: 10000 });
  assert.strictEqual(aCalls, 1, 'gym-a re-fetches after a booking invalidated it');

  let bCalls = 0;
  await cache.getOrFetch('timetable|gym-b|d1|d2', async () => { bCalls++; return []; }, { ttlMs: 10000 });
  assert.strictEqual(bCalls, 0, "and one gym's booking never evicts another gym's schedule");
});

check('the key separates gyms and date ranges', async () => {
  const seen = [];
  const make = (tag) => async () => { seen.push(tag); return [{ tag }]; };
  await cache.getOrFetch('timetable|psycle-london|2026-09-15|2026-09-22', make('psycle'), { ttlMs: 10000 });
  await cache.getOrFetch('timetable|jab-boxing|2026-09-15|2026-09-22', make('jab'), { ttlMs: 10000 });
  await cache.getOrFetch('timetable|psycle-london|2026-09-22|2026-09-29', make('psycle-week2'), { ttlMs: 10000 });
  assert.deepStrictEqual(seen, ['psycle', 'jab', 'psycle-week2'],
    'a key missing gym or range would serve one gym/week as another');
});

(async () => {
  for (const { name, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}\n      ${err.message}`);
    }
  }
  if (passed === checks.length) {
    console.log(`🎉 ${passed}/${checks.length} schedule-cache checks passed.`);
  } else {
    console.error(`⚠️  ${passed}/${checks.length} passed. ${checks.length - passed} FAILED.`);
    process.exit(1);
  }
})();
