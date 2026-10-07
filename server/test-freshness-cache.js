// C2-5 (rebuilt 2026-10-06): heartbeat-stamp-driven freshness for the shared schedule cache.
// Accepted staleness: occupancy can lag up to the ceiling (the `events` stamp does not move on
// seat-count changes; the official website has the same behaviour). See AGENTS.md.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);

const assert = require('assert');
const { createCache } = require('./schedule-cache');
const { createFreshness } = require('./freshness');
const mock = require('./mock');
const { getProvider } = require('./providers');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('stale entry + UNCHANGED stamp: no refetch, freshness extended, counted', async () => {
  const c = createCache();
  let calls = 0;
  const fetcher = async () => { calls++; return calls; };
  const stamp = async () => 'S1';
  const o = { ttlMs: 20, stamp, ceilingMs: 60000 };
  await c.getOrFetch('k', fetcher, o);
  await sleep(40);
  assert.strictEqual(await c.getOrFetch('k', fetcher, o), 1);
  assert.strictEqual(calls, 1, 'no refetch while the stamp is unchanged');
  // freshness was extended: an immediate re-read is a plain hit, no stamp call needed
  let stampCalls = 0;
  const o2 = { ...o, stamp: async () => { stampCalls++; return 'S1'; } };
  await c.getOrFetch('k', fetcher, o2);
  assert.strictEqual(stampCalls, 0);
  assert.strictEqual(c.getStats().stampUnchanged, 1);
});

check('CHANGED stamp: stale served, refetched behind the request, new stamp stored', async () => {
  const c = createCache();
  let calls = 0; let s = 'S1';
  const fetcher = async () => { calls++; return `v${calls}`; };
  const o = { ttlMs: 20, stamp: async () => s, ceilingMs: 60000 };
  await c.getOrFetch('k', fetcher, o);
  s = 'S2';
  await sleep(40);
  assert.strictEqual(await c.getOrFetch('k', fetcher, o), 'v1', 'stale-while-revalidate');
  await sleep(10);
  assert.strictEqual(calls, 2);
  assert.strictEqual(c.getStats().stampChanged, 1);
  await sleep(40);
  await c.getOrFetch('k', fetcher, o); // stamp S2 == stored S2 -> extended, no 3rd call
  await sleep(10);
  assert.strictEqual(calls, 2);
});

check('CEILING: unchanged stamp past the hard max-age still refetches', async () => {
  const c = createCache();
  let calls = 0;
  const fetcher = async () => { calls++; return calls; };
  const o = { ttlMs: 10, stamp: async () => 'S1', ceilingMs: 50 };
  await c.getOrFetch('k', fetcher, o);
  await sleep(80);
  await c.getOrFetch('k', fetcher, o);
  await sleep(10);
  assert.strictEqual(calls, 2);
  assert.strictEqual(c.getStats().ceilingRefetches, 1);
});

check('stamp unavailable (null / throw): falls back to TTL SWR, never empty, counted', async () => {
  for (const bad of [async () => null, async () => { throw new Error('429'); }]) {
    const c = createCache();
    let calls = 0; let ok = true;
    const fetcher = async () => { calls++; return 'x'; };
    const o = { ttlMs: 10, stamp: async () => (ok ? 'S1' : bad()), ceilingMs: 60000 };
    await c.getOrFetch('k', fetcher, o);
    ok = false;
    await sleep(30);
    assert.strictEqual(await c.getOrFetch('k', fetcher, o), 'x', 'stale value served, not empty');
    await sleep(10);
    assert.strictEqual(calls, 2, 'refetch via existing TTL behaviour');
    assert.strictEqual(c.getStats().stampUnavailable, 1);
  }
});

check('no stamp option (e.g. MarianaTek): behaviour identical to before', async () => {
  const c = createCache();
  let calls = 0;
  const fetcher = async () => { calls++; return calls; };
  await c.getOrFetch('k', fetcher, { ttlMs: 10 });
  await sleep(30);
  await c.getOrFetch('k', fetcher, { ttlMs: 10 });
  await sleep(10);
  assert.strictEqual(calls, 2);
  assert.strictEqual(c.getStats().stampUnchanged, 0);
});

check('invalidate() still forces a refetch despite an unchanged stamp (write path)', async () => {
  const c = createCache();
  let calls = 0;
  const fetcher = async () => { calls++; return calls; };
  const o = { ttlMs: 10, stamp: async () => 'S1', ceilingMs: 60000 };
  await c.getOrFetch('timetable|g|a|b', fetcher, o);
  c.invalidate('timetable|g|');
  await c.getOrFetch('timetable|g|a|b', fetcher, o);
  assert.strictEqual(calls, 2);
});

check('freshness: heartbeat memoised + single-flight; failures counted and memoised', async () => {
  let hb = 0;
  const provider = { hasFreshnessStamps: () => true, getFreshnessStamps: async () => { hb++; await sleep(10); return { events: 'E1', studios: 'T1' }; } };
  const f = createFreshness({ memoMs: 200, failMemoMs: 200 });
  const get = f.stampFor('g', provider, null, ['events']);
  const r = await Promise.all([get(), get(), get()]);
  assert.deepStrictEqual(r, ['E1', 'E1', 'E1']);
  await get();
  assert.strictEqual(hb, 1, 'one upstream heartbeat for 4 reads');
  assert.strictEqual(await f.stampFor('g', provider, null, ['events', 'studios'])(), 'E1|T1');
  assert.strictEqual(await f.stampFor('g', provider, null, ['nope'])(), null, 'missing resource -> no stamp');

  const bad = { hasFreshnessStamps: () => true, getFreshnessStamps: async () => { hb++; const e = new Error('429'); e.status = 429; throw e; } };
  const f2 = createFreshness({ memoMs: 200, failMemoMs: 200 });
  const before = hb;
  assert.strictEqual(await f2.stampFor('g', bad, null, ['events'])(), null);
  assert.strictEqual(await f2.stampFor('g', bad, null, ['events'])(), null);
  assert.strictEqual(hb - before, 1, 'failure is memoised so a throttled gym is not hammered');
  assert.strictEqual(f2.getStats().heartbeatFailures, 1);
  assert.strictEqual(f2.getStats().heartbeatChecks, 1);
});

check('freshness: timeout counts as failure', async () => {
  const slow = { hasFreshnessStamps: () => true, getFreshnessStamps: () => new Promise(() => {}) };
  const f = createFreshness({ timeoutMs: 30 });
  assert.strictEqual(await f.stampFor('g', slow, null, ['events'])(), null);
  assert.strictEqual(f.getStats().heartbeatFailures, 1);
});

check('freshness: provider without the hook gets no stamp function', async () => {
  const f = createFreshness();
  assert.strictEqual(f.stampFor('jab', { hasFreshnessStamps: () => false }, null, ['events']), undefined);
  const mt = getProvider('jab-boxing');
  assert.strictEqual(mt.hasFreshnessStamps(), false);
  assert.strictEqual(f.stampFor('jab-boxing', mt, null, ['events']), undefined);
});

check('CodexFit adapter reads the mock /heartbeat in the LIVE envelope; stamp is controllable', async () => {
  const p = getProvider('psycle-london');
  assert.strictEqual(p.hasFreshnessStamps(), true);
  const session = { accessToken: 'mock-jwt-token' };
  const a = await p.getFreshnessStamps(session);
  assert.ok(a.events && a['event-types'] && a.studios && a.locations && a.instructors, 'resource map');
  assert.ok(!('logged-in' in a), 'non-timestamp key dropped');
  const raw = await (await mock.handleMockRequest('/heartbeat', 'GET')).json();
  assert.strictEqual(raw.data['logged-in'], false, 'live envelope {data:{...,"logged-in":false}}');
  mock.setMockHeartbeatStamp('events', '2030-01-01T00:00:00.000000Z');
  const b = await p.getFreshnessStamps(session);
  assert.strictEqual(b.events, '2030-01-01T00:00:00.000000Z');
  assert.strictEqual(b.studios, a.studios);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of checks) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); } catch (err) { console.error(`  ✗ ${name}\n      ${err.stack || err.message}`); }
  }
  if (passed === checks.length) console.log(`🎉 ${passed}/${checks.length} freshness-cache checks passed.`);
  else { console.error(`⚠️  ${passed}/${checks.length} passed.`); process.exit(1); }
})();
