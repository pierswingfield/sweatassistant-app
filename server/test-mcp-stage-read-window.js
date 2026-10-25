'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'fixture-only-read-window-key';
process.env.JAB_BOXING_ENABLED = 'true';
const { configuration, assertRequest, permitsActor, gatewayWindow } = require('./mcp/jab-read-window');
const { createServer } = require(process.env.MCP_TEST_GATEWAY_MODULE || './mcp-stage-jab-egress');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-read-window-'));
const authorization = 'Bearer fixture-provider-session';
const headers = { authorization };
const origin = 'https://jabboxingclub.marianatek.com';
const prefix = `${origin}/api/customer/v1`;
const day = '2026-10-25';
let count = 0;
function check(value, message) { assert.ok(value, message); count++; }
function fixture(name, clock = Date.now) {
  const configurationFile = path.join(root, `${name}.json`), stateFile = path.join(root, `${name}.state`);
  const now = clock();
  const c = { windowId: `fixture-window-${name}`, accountId: 42, day, startsAt: now - 1000, expiresAt: now + 119000,
    authorizationHash: crypto.createHash('sha256').update(authorization).digest('hex') };
  fs.writeFileSync(configurationFile, JSON.stringify(c), { mode: 0o600 });
  return { c, configurationFile, stateFile, window: gatewayWindow({ configurationFile, stateFile, now: clock }) };
}
const search = `${prefix}/classes?min_start_date=${day}&max_start_date=${day}&page_size=100`;
async function main() {
  const f = fixture('policy');
  const c = configuration(f.configurationFile);
  check(permitsActor(f.configurationFile, { userId: 42 }, 'get_credits'), 'selected actor may use window');
  check(!permitsActor(f.configurationFile, { userId: 43 }, 'get_credits'), 'other actor denied');
  check(!permitsActor(f.configurationFile, { userId: 42 }, 'get_automation'), 'non-provider operation cannot use read gateway');
  for (const [url, options] of [
    [`${prefix}/me/credits`, { method: 'POST', headers }],
    [`${prefix}/me/credits`, { headers: { authorization: 'Bearer another-account' } }],
    [`${prefix}/me/account`, { headers }], [`${origin}/o/token/`, { method: 'POST', headers, body: 'grant_type=refresh_token' }],
    [`${prefix}/me/reservations?is_upcoming=false&page_size=100`, { headers }],
    [search + '&page=2', { headers }], [search + '&page_size=100', { headers }],
    [search.replace('min_start_date', '%6din_start_date'), { headers }],
    [search.replace('2026-10-25', '2026-10-26'), { headers }],
    [search.replace('jabboxingclub.marianatek.com', 'evil.example'), { headers }],
    [`${prefix}/classes/unknown`, { headers }],
    [`${prefix}/classes/%2e%2e/me/credits`, { headers }],
  ]) { assert.throws(() => f.window.admit(url, options)); count++; }
  const admission = f.window.admit(search, { headers });
  check(f.window.finish(admission, 200, Buffer.from(JSON.stringify({ results: [{ id: 123 }, { id: 456 }], meta: { pagination: { pages: 1 } } }))), 'single page accepted');
  check(f.window.admit(`${prefix}/classes/123`, { headers }).kind === 'read', 'first returned detail id accepted');
  assert.throws(() => f.window.admit(`${prefix}/classes/456`, { headers })); count++;
  const restarted = gatewayWindow({ configurationFile: f.configurationFile, stateFile: f.stateFile });
  for (let i = 0; i < 4; i++) restarted.admit(`${prefix}/me/credits`, { headers });
  assert.throws(() => restarted.admit(`${prefix}/me/credits`, { headers })); count++;
  check(JSON.parse(fs.readFileSync(f.stateFile)).count === 6, 'aggregate six cap persists across restart');
  const changed = { ...f.c, windowId: 'replacement-window-forbidden' };
  fs.writeFileSync(f.configurationFile, JSON.stringify(changed));
  assert.throws(() => restarted.admit(`${prefix}/me/credits`, { headers })); count++;
  let now = Date.now(); const expired = fixture('expiry', () => now); now += 120000;
  assert.throws(() => expired.window.admit(`${prefix}/me/credits`, { headers })); count++;
  check(!permitsActor(expired.configurationFile, { userId: 42 }, 'get_credits', now), 'tool availability expires');
  const corrupt = fixture('corrupt'); fs.writeFileSync(corrupt.stateFile, '{broken', { mode: 0o600 });
  assert.throws(() => corrupt.window.admit(`${prefix}/me/credits`, { headers })); count++;
  const locked = fixture('lock'); fs.writeFileSync(`${locked.stateFile}.lock`, '', { mode: 0o600 });
  assert.throws(() => locked.window.admit(`${prefix}/me/credits`, { headers })); count++;

  let calls = 0, status = 200, paged = false;
  const g = fixture('gateway');
  const server = createServer({ gatewayKey: 'fixture-key-at-least-thirty-two-characters', readWindow: g.window,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify(paged ? { results: [], next: 'https://evil.example/page' } : { results: [] }), { status }); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/profile-request`;
  const request = (url, method = 'GET') => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': 'fixture-key-at-least-thirty-two-characters' }, body: JSON.stringify({ url, method, headers, body: null }) });
  try {
    check((await request(`${prefix}/me/credits`)).status === 200, 'explicit read-window credits reach transport');
    const before = calls;
    check((await request(`${prefix}/me/account`)).status === 403 && calls === before, 'profile denied before transport during window');
    paged = true;
    check((await request(search)).status === 502, 'unexpected pagination stops window');
    check((await request(`${prefix}/me/credits`)).status === 403, 'stopped window cannot make another request');
  } finally { await new Promise(resolve => server.close(resolve)); }
  for (const refused of [401, 429]) {
    const h = fixture(`status${refused}`); let attempts = 0;
    const srv = createServer({ gatewayKey: 'fixture-key-at-least-thirty-two-characters', readWindow: h.window,
      fetchImpl: async () => { attempts++; return new Response('{}', { status: refused }); } });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const ep = `http://127.0.0.1:${srv.address().port}/profile-request`;
    const send = () => fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': 'fixture-key-at-least-thirty-two-characters' }, body: JSON.stringify({ url: `${prefix}/me/credits`, method: 'GET', headers, body: null }) });
    try { check((await send()).status === 502, `${refused} stops without passthrough reauthentication`); check((await send()).status === 403 && attempts === 1, 'no outbound retry'); }
    finally { await new Promise(resolve => srv.close(resolve)); }
  }
  for (const cancelled of [false, true]) {
    const h = fixture(cancelled ? 'disconnect' : 'deadline'); let signal;
    const srv = createServer({ gatewayKey: 'fixture-key-at-least-thirty-two-characters', readWindow: h.window, deadlineMs: 100,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        signal = options.signal; signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true });
      }) });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    const ep = `http://127.0.0.1:${srv.address().port}/profile-request`;
    const body = JSON.stringify({ url: `${prefix}/me/credits`, method: 'GET', headers, body: null });
    try {
      if (cancelled) {
        const req = http.request(ep, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-stage-egress-key': 'fixture-key-at-least-thirty-two-characters' } });
        req.on('error', () => {}); req.end(body);
        for (let i = 0; i < 50 && !signal; i++) await new Promise(resolve => setTimeout(resolve, 1));
        assert.ok(signal, 'upstream started'); req.destroy();
        await new Promise(resolve => setTimeout(resolve, 20));
      } else {
        const response = await fetch(ep, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': 'fixture-key-at-least-thirty-two-characters' }, body });
        check(response.status === 502, 'deadline ends stalled acceptance request');
      }
      check(signal?.aborted, 'read-window cancellation reaches upstream transport');
      const state = JSON.parse(fs.readFileSync(h.stateFile));
      check(state.count === 1 && state.stopped, 'cancelled attempt remains charged and window stops');
    } finally { await new Promise(resolve => srv.close(resolve)); }
  }
  // Reach the real adapter -> logger -> broker seam with a real fixture grant.
  const db = require('./db'), store = require('./mcp/store');
  const { providerReadsAllowed } = require('./mcp/tools');
  const accountId = db.createAccount('window-fixture@example.test', 'fixture-password');
  db.linkGym(accountId, 'jab-boxing'); store.registerClient('window-fixture', 'Window fixture');
  const issuer = 'https://mcp.example.test/';
  const scopes = ['schedule:read', 'account:read', 'automation:read'];
  const grantId = store.createGrant({ userId: accountId, issuer, subject: `account:${accountId}`, clientId: 'window-fixture', scopes,
    gymIds: ['jab-boxing'], expiresAt: Date.now() + 60000, consentReference: 'fixture-consent' });
  const identity = { issuer, subject: `account:${accountId}`, clientId: 'window-fixture', scopes, grantId, expiresAt: Date.now() + 60000 };
  const adapter = fixture('adapter'); adapter.c.accountId = accountId;
  fs.writeFileSync(adapter.configurationFile, JSON.stringify(adapter.c));
  const config = { providerReads: false, stageReadWindowFile: adapter.configurationFile };
  check(providerReadsAllowed(identity, 'get_credits', config), 'specific account tools available with global provider flag off');
  check(!providerReadsAllowed(identity, 'get_credits', { providerReads: false }), 'default remains disabled');
  let upstreamReads = 0;
  const capturedClass = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__/marianatek/classes-list.json'))).results[0];
  const classRow = { ...capturedClass, start_date: day };
  const broker = createServer({ gatewayKey: 'fixture-key-at-least-thirty-two-characters', readWindow: adapter.window,
    fetchImpl: async (url, options) => {
      upstreamReads++; assert.equal(options.method, 'GET');
      if (String(url) === search) return new Response(JSON.stringify({ results: [classRow], meta: { pagination: { pages: 1 } } }));
      if (String(url) === `${prefix}/classes/${classRow.id}`) return new Response(JSON.stringify(classRow));
      if (String(url) === `${prefix}/me/reservations?is_upcoming=true&page_size=100`) return new Response('{"results":[]}');
      assert.equal(String(url), `${prefix}/me/credits`);
      return new Response(JSON.stringify({ results: [{ product_id: 1, name: 'Fixture credits', credits_remaining: 2 }] }));
    } });
  await new Promise(resolve => broker.listen(0, '127.0.0.1', resolve));
  process.env.MCP_STAGE_JAB_PROFILE_ONLY = 'true';
  process.env.MCP_STAGE_JAB_READ_WINDOW_FILE = adapter.configurationFile;
  process.env.MCP_STAGE_JAB_GATEWAY_URL = `http://127.0.0.1:${broker.address().port}`;
  process.env.MCP_STAGE_JAB_GATEWAY_KEY = 'fixture-key-at-least-thirty-two-characters';
  const provider = require('./providers').getProvider('jab-boxing');
  try {
    const session = { accessToken: 'fixture-provider-session' };
    const run = (tool, scope, fn) => require('./mcp/context').run({ identity, scope, gymId: 'jab-boxing', providerReads: true, tool }, fn);
    const classes = await run('search_classes', 'schedule:read', () => provider.fetchTimetable({ startDate: day, endDate: day }, session));
    check(classes.length === 1, 'real adapter one-day class query matches exact gateway policy');
    const detail = await run('get_class_details', 'schedule:read', () => provider.fetchEventDetails(String(classRow.id), session));
    check(detail.event.id === String(classRow.id), 'real adapter detail uses gateway-learned class id');
    const bookings = await run('get_my_bookings', 'account:read', () => provider.listBookings(session));
    check(bookings.length === 0, 'real adapter upcoming bookings query matches exact gateway policy');
    const result = await run('get_credits', 'account:read', () => provider.getCredits(session));
    check(result[0].count === 2 && upstreamReads === 4, 'all four real adapter reads traverse restricted broker once each');
    await assert.rejects(provider.getCredits({ accessToken: 'fixture-provider-session' })); count++;
    check(upstreamReads === 4, 'native non-MCP read denied without transport');
    adapter.c.expiresAt = Date.now() - 1; fs.writeFileSync(adapter.configurationFile, JSON.stringify(adapter.c));
    check(!providerReadsAllowed(identity, 'get_credits', config), 'tool visibility automatically off after expiry');
  } finally { delete process.env.MCP_STAGE_JAB_READ_WINDOW_FILE; await new Promise(resolve => broker.close(resolve)); }
  process.stdout.write(`stage read-window policy checks passed: ${count}\n`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
