// Common admission: no real provider calls; saturate actual transport callbacks.
process.env.DB_PATH = ':memory:';
process.env.JAB_BOXING_ENABLED = 'true';
process.env.ENCRYPTION_KEY ||= 'd'.repeat(64);
process.env.PROVIDER_ADMISSION_ENABLED = 'true';
const assert = require('node:assert/strict');
const db = require('./db');
let admission = require('./provider-admission');
const { timedProviderFetch } = require('./logger');
const backoff = require('./rate-limit-backoff');
const { listGyms } = require('./gyms.config');
const gym = listGyms()[0].id;
let checks = 0;
const check = (v, why) => { assert.ok(v, why); checks++; };
const reset = () => { db.db.prepare('DELETE FROM mcp_budgets').run(); backoff._resetRateLimitBackoffForTests(); };
const call = (lane, userId, fetcher = async () => new Response('{}'), targetGym = gym) => admission.run({ lane, userId }, () => timedProviderFetch(targetGym, 'GET', '/fixture', fetcher));
(async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const held = [];
  // Optional traffic can occupy four slots, leaving interactive and scheduled capacity.
  for (let i = 0; i < 3; i++) held.push(call('background', i + 1, async () => { await gate; return new Response('{}'); }));
  let attempts = 0;
  await assert.rejects(call('background', 8, async () => { attempts++; return new Response('{}'); }), e => e.code === 'RATE_LIMITED');
  check(attempts === 0, 'optional saturation refuses before network');
  await call('interactive', 9);
  await call('scheduler', 10);
  check(true, 'interactive action and scheduler GET survive optional saturation');
  release(); await Promise.all(held);
  reset();
  let actual = 0;
  const fetcher = async () => { actual++; return new Response('{}'); };
  for (let i = 0; i < 30; i++) await call('background', i + 100, fetcher);
  await assert.rejects(call('background', 500, fetcher), e => {
    check(!backoff.noteThrottleError(gym, e), 'internal capacity refusal never arms provider cooldown');
    return e.status === 429 && e.retryAfter > 0;
  });
  check(actual === 30, 'hard optional per-gym window cap');
  for (let i = 0; i < 30; i++) await call('interactive', i + 1000, fetcher);
  await assert.rejects(call('interactive', 1500, fetcher), e => e.status === 429);
  check(actual === 60, 'interactive has reserved window capacity, then stops');
  for (let i = 0; i < 30; i++) await call('scheduler', i + 2000, fetcher);
  await assert.rejects(call('scheduler', 2500, fetcher), e => e.status === 429);
  check(actual === 90, 'scheduler reservation stays available and hard total remains bounded');
  reset();
  for (let i = 0; i < 30; i++) await call('interactive', 4000, fetcher);
  await assert.rejects(call('interactive', 4000, fetcher), e => e.status === 429);
  // A new module instance still reads the durable budget.
  delete require.cache[require.resolve('./provider-admission')];
  const restarted = require('./provider-admission');
  admission = restarted;
  await assert.rejects(restarted.run({ lane: 'interactive', userId: 4000 }, () => timedProviderFetch(gym, 'GET', '/fixture', fetcher)), e => e.status === 429);
  check(true, 'account cap survives transport module restart');
  reset();
  await assert.rejects(call('background', 1, async () => { throw new Error('fixture outage'); }), /fixture outage/);
  await call('scheduler', 1);
  await call('background', 1, async () => new Response('{}', { status: 429, headers: { 'retry-after': '2' } }));
  await assert.rejects(call('interactive', 2, fetcher), e => e.status === 429);
  check(backoff.isGymRateLimited(gym), '429 from background pauses every lane');
  reset();
  const before = actual;
  await assert.rejects(call('interactive', 5, async signal => { check(!!signal, 'universal timeout signal reaches transport'); return new Response('x'.repeat(4 * 1024 * 1024 + 1)); }), e => e.code === 'PROVIDER_RESPONSE_TOO_LARGE');
  await call('scheduler', 6, fetcher);
  check(actual === before + 1, 'oversized response releases reservation');
  // Class prefetch is explicitly scheduler work, regardless of HTTP verb.
  const provider = require('./providers').getProvider(gym);
  const original = provider.fetchEventDetails;
  let lane;
  provider.fetchEventDetails = async () => { lane = admission.current()?.lane; return { slots: [] }; };
  try { await require('./scheduler').prefetchAutoBookSlots([{ gym_id: gym, user_id: 1, event_id: 'fixture' }], 0); }
  finally { provider.fetchEventDetails = original; }
  check(lane === 'scheduler', 'actual scheduler preflight enters reserved lane');
  reset();
  const otherGym = listGyms().find(g => g.id !== gym).id;
  let fleetActual = 0;
  const counted = async () => { fleetActual++; return new Response('{}'); };
  for (let i = 0; i < 60; i++) await call('background', 5000 + i, counted, i % 2 ? gym : otherGym);
  await assert.rejects(call('background', 6000, counted, otherGym), e => e.status === 429);
  for (let i = 0; i < 30; i++) await call('interactive', 7000 + i, counted, i % 2 ? gym : otherGym);
  await assert.rejects(call('interactive', 8000, counted, otherGym), e => e.status === 429);
  for (let i = 0; i < 30; i++) await call('scheduler', 9000 + i, counted, i % 2 ? gym : otherGym);
  await assert.rejects(call('scheduler', 10000, counted, otherGym), e => e.status === 429);
  check(fleetActual === 120, 'fleet hard ceiling and both reservations survive multi-gym multi-account flood');
  reset();
  const window = Math.floor(Date.now() / 86400000);
  db.db.prepare('INSERT INTO mcp_budgets (budget_key, window_id, count, expires_at) VALUES (?, ?, ?, ?)').run('common:daily:optional:fleet', window, 4000, (window + 1) * 86400000);
  await assert.rejects(call('background', 11, counted), e => e.status === 429);
  await call('interactive', 11, counted);
  await call('scheduler', 11, counted);
  check(true, 'daily optional exhaustion preserves essential daily capacity');
  reset();
  const store = require('./mcp/store'); const charge = store.charge;
  const beforeFailure = fleetActual;
  store.charge = () => { throw new Error('fixture database unavailable'); };
  try { await assert.rejects(call('interactive', 12, counted), /database unavailable/); }
  finally { store.charge = charge; }
  check(beforeFailure === fleetActual, 'budget storage failure refuses before network');
  await call('scheduler', 12, counted);
  reset();
  // A stalled real local HTTP body must abort its socket and free all slots.
  const http = require('node:http');
  let closed = false;
  const local = http.createServer((_req, res) => { res.writeHead(200); res.write('{'); res.on('close', () => { closed = true; }); });
  await new Promise(r => local.listen(0, '127.0.0.1', r));
  const start = Date.now();
  try {
    await assert.rejects(call('interactive', 77, signal => fetch(`http://127.0.0.1:${local.address().port}`, { signal })), e => e.code === 'DEADLINE_EXCEEDED');
    await new Promise(r => setTimeout(r, 30));
    check(closed && Date.now() - start < 11000, 'deadline aborts actual socket during stalled body');
    await call('scheduler', 77);
  } finally { local.closeAllConnections(); await new Promise(r => local.close(r)); }
  reset();
  const cf = require('./providers').getProvider(gym);
  const mt = require('./providers').getProvider(listGyms().find(g => g.provider === 'marianatek').id);
  const originalFetch = global.fetch;
  let authHops = 0;
  global.fetch = async (_url, options) => { authHops++; check(!!options.signal && options.redirect === 'manual', 'credential hop gets timeout and explicit redirect policy'); return new Response('{}', { status: 400 }); };
  try {
    await assert.rejects(admission.run({ lane: 'interactive', userId: 88 }, () => cf.login({ email: 'fixture@example.test', password: 'fixture' })));
    await assert.rejects(admission.run({ lane: 'interactive', userId: 88 }, () => mt.refreshSession({ refreshToken: 'fixture' }, null)));
    check(authHops === 2 && db.db.prepare("SELECT count FROM mcp_budgets WHERE budget_key = 'common:account:88'").get().count === 2, 'both native credential protocols charge shared durable budgets');
  } finally { global.fetch = originalFetch; }
  reset();
  let metadataActive = 0; let metadataPeak = 0; let metadataCalls = 0;
  global.fetch = async () => {
    metadataCalls++; metadataActive++; metadataPeak = Math.max(metadataPeak, metadataActive);
    await new Promise(r => setTimeout(r, 5)); metadataActive--;
    return new Response(JSON.stringify({ data: [] }));
  };
  try {
    await admission.run({ lane: 'interactive', userId: 66 }, () => cf.fetchMetadata({}, { accessToken: 'fixture-token' }));
    check(metadataCalls === 4 && metadataPeak === 4, 'cold PWA metadata fan-out fits its essential account reservation');
  } finally { global.fetch = originalFetch; }
  reset();
  const cache = require('./schedule-cache').createCache();
  let unblock;
  const stalled = new Promise(r => { unblock = r; });
  const low = admission.run({ lane: 'background', userId: 1 }, () => cache.getOrFetch('fixture', async () => { await stalled; throw new Error('cancelled optional owner'); }));
  const urgent = await admission.run({ lane: 'scheduler', userId: 2 }, () => cache.getOrFetch('fixture', async () => 'critical result'));
  check(urgent === 'critical result', 'scheduler cold miss does not inherit optional single-flight owner');
  unblock(); await low; // stale-if-error can now reuse the successful shared value.
  const cached = await admission.run({ lane: 'interactive', userId: 3 }, () => cache.getOrFetch('fixture', () => { throw new Error('cache hit must not fetch'); }));
  check(cached === 'critical result', 'completed cache values remain shared across lanes');
  console.log(`Provider admission: ${checks} checks passed`);
})().catch(e => { console.error(e.message); process.exitCode = 1; });
