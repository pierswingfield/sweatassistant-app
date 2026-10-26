// Actual OAuth/HTTP/SDK action flow with mocked app-provider operations only.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-actions-'));
process.env.DB_PATH = path.join(temp, 'fixture.db');
process.env.ENCRYPTION_KEY = 'b'.repeat(64); process.env.JAB_BOXING_ENABLED = 'true';
const assert = require('node:assert/strict');
global.fetch = async () => { throw new Error('Fixture attempted forbidden network access'); };
const express = require('express');
const db = require('./db'), access = require('./mcp/access'), store = require('./mcp/store');
const { mountAuthorization, loadAuthorizationConfiguration } = require('./mcp/authorization');
const { mountMcp } = require('./mcp/router');
const { verifier } = require('./mcp/auth');
const context = require('./mcp/context');
const { getProvider } = require('./providers');
const { listGyms } = require('./gyms.config');
const calendar = require('./calendar'); calendar.scheduleRefresh = () => {};
const origin = 'https://actions.example.test', password = 'isolated-action-password';
let server, port, checks = 0, writes = 0, mode = 'success', bookings = [], token, identity, configuration, releaseWrite, writeStarted;
const check = (value, label) => { assert.ok(value, label); checks++; };
const fields = html => Object.fromEntries([...html.matchAll(/type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1],m[2]]));
const clear = () => db.db.prepare('DELETE FROM mcp_budgets').run();
async function request(url, body, cookie, headers = {}) {
  return new Promise((resolve, reject) => {
    const json = headers['content-type'] === 'application/json';
    const bytes = body === undefined ? null : json ? JSON.stringify(body) : body instanceof URLSearchParams ? body.toString() : new URLSearchParams(body).toString();
    const req = require('node:http').request(`http://127.0.0.1:${port}${url}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { host: 'actions.example.test', ...(bytes ? { 'content-type': 'application/x-www-form-urlencoded', origin } : {}), ...(cookie ? { cookie } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); let data; try { data = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, text, data, cookie: res.headers['set-cookie']?.[0].split(';')[0] || cookie, fields: fields(text) });
      });
    }); req.on('error', reject); if (bytes) req.write(bytes); req.end();
  });
}
async function signIn(tx, email = 'actions@example.test') {
  return request('/oauth/login', { interaction: tx.fields.interaction, csrf: tx.fields.csrf, email, password }, tx.cookie);
}
async function management() { return signIn(await request('/oauth/connections')); }
async function preference(enabled) {
  clear(); const tx = await management();
  return request('/oauth/connections/writes', { interaction: tx.fields.interaction, csrf: tx.fields.csrf, ...(enabled ? { writesEnabled: 'true' } : {}) }, tx.cookie);
}
let nextId = 1;
async function rpc(method, params = {}) {
  return request('/mcp', { jsonrpc: '2.0', id: nextId++, method, params }, null,
    { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${token}`, 'mcp-protocol-version': '2025-11-25' });
}
async function call(name, args) { const r = await rpc('tools/call', { name, arguments: args }); return { ...r, result: r.data?.result?.structuredContent, error: r.data?.result?.isError ? JSON.parse(r.data.result.content[0].text).code : r.data?.code }; }
async function approve(actionId, email) { clear(); const tx = await signIn(await request(`/oauth/actions/${actionId}`), email); return { tx, result: await request('/oauth/actions/decision', { ...tx.fields, decision: 'allow' }, tx.cookie) }; }
(async () => {
  const jose = await import('jose'), pair = await jose.generateKeyPair('ES256', { extractable: true });
  const privateKey = { ...await jose.exportJWK(pair.privateKey), kid: 'action-fixture', alg: 'ES256' };
  const publicKey = { ...await jose.exportJWK(pair.publicKey), kid: 'action-fixture', use: 'sig' };
  const keyFile = path.join(temp, 'private.json'), jwksFile = path.join(temp, 'jwks.json'), clientsFile = path.join(temp, 'clients.json');
  fs.writeFileSync(keyFile, JSON.stringify(privateKey), { mode: 0o600 }); fs.writeFileSync(jwksFile, JSON.stringify({ keys: [publicKey] }));
  fs.writeFileSync(clientsFile, JSON.stringify({ clients: [{ id: 'action-fixture', name: 'Fixture AI', public: true, redirectUris: ['https://client.example.test/callback'] }] }));
  configuration = { enabled: true, issuer: origin + '/', resource: origin + '/mcp', host: 'actions.example.test', origins: [origin], jwksFile, providerReads: true, writesEnabled: true };
  const local = loadAuthorizationConfiguration(configuration, { MCP_AUTH_SERVER_ENABLED: 'true', MCP_SIGNING_KEY_FILE: keyFile, MCP_CLIENTS_FILE: clientsFile });
  const userId = db.createAccount('actions@example.test', password); db.createAccount('other@example.test', password);
  const gym = listGyms().find(g => g.enabled && g.capabilities.atomicSwap), gymId = gym.id;
  db.linkGym(userId, gymId);
  db.runWithGymContext(userId, gymId, () => db.updateUserJWT(userId, 'fixture-gym-session', new Date(Date.now() + 600000).toISOString()));
  const provider = getProvider(gymId), original = new Map();
  const stub = (name, fn) => { original.set(name, provider[name]); provider[name] = fn; };
  const startAt = new Date(Date.now() + 86400000).toISOString();
  stub('listBookings', async () => bookings.map(b => ({ ...b })));
  stub('fetchEventDetails', async eventId => ({ event: { id: eventId, name: '<script>external</script>', releaseAt: new Date(Date.now() - 60000).toISOString(), startAt, timeZone: gym.timezone, credits: { required: 1 } },
    slots: ['one','two'].map(id => ({ id, label: id, isAvailable: !bookings.some(b => b.slotId === id) })) }));
  stub('getBookingEntitlement', async () => ({ selfBookingLimit: 3 }));
  stub('getCancelPenalty', async () => ({ penalty: mode === 'fee' ? 'fee' : 'none' }));
  function transport() {
    if (mode === 'disable-during-hop') access.setWritePreference(userId, false);
    context.admitProvider(gymId, 'POST', mode === 'credential-hop' ? 'credential' : undefined); writes++;
  }
  stub('bookSlot', async (eventId, slots, _session, options) => {
    assert.equal(options.existingCreditOnly, true);
    if (mode === 'definite-refusal') return { ok: false, status: 403 };
    transport();
    if (mode === 'delayed') { writeStarted = true; await new Promise(resolve => { releaseWrite = resolve; }); }
    const b = { bookingId: `reservation-${writes}`, eventId, slotId: slots[0] || null }; bookings.push(b);
    if (mode === 'uncertain') throw new Error('simulated lost response after provider accepted');
    return { ok: true, ...b };
  });
  stub('swapSpots', async (bookingId, _from, to, _session, options) => {
    assert.equal(options.allowCancelRebook, false); transport();
    bookings.find(b => b.bookingId === bookingId).slotId = to; return { ok: true, bookingId, slotId: to };
  });
  stub('cancelBooking', async bookingId => { transport(); bookings = bookings.filter(b => b.bookingId !== bookingId); return true; });
  const app = express(); mountAuthorization(app, configuration, { config: local }); mountMcp(app, configuration);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); port = server.address().port;
  const pkce = crypto.randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: 'action-fixture', redirect_uri: 'https://client.example.test/callback', resource: configuration.resource,
    state: 'isolated-action-state-123456789', scope: 'schedule:read account:read bookings:write', code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(pkce).digest('base64url') });
  const tx = await signIn(await request(`/oauth/authorize?${query}`));
  const body = new URLSearchParams({ ...tx.fields, decision: 'allow' }); for (const scope of ['schedule:read','account:read','bookings:write']) body.append('scopes', scope);
  const consent = await request('/oauth/consent', body, tx.cookie);
  const code = new URL(consent.headers.location).searchParams.get('code');
  const exchanged = await request('/oauth/token', { grant_type: 'authorization_code', client_id: 'action-fixture', code, code_verifier: pkce, redirect_uri: 'https://client.example.test/callback', resource: configuration.resource });
  token = exchanged.data.access_token; identity = await verifier(configuration)(token);
  check(!!token, 'real OAuth exchange creates explicitly scoped action token');
  check(!(await rpc('tools/list')).data.result.tools.some(t => t.name === 'prepare_booking'), 'default-off preference hides action tools');
  await preference(true);
  check((await rpc('tools/list')).data.result.tools.some(t => t.name === 'execute_booking_action'), 'explicit preference exposes globally enabled scoped action tools');
  const prepare = (requestId, extra = {}) => call('prepare_booking', { gymId, eventId: 'future-class', slotId: 'one', requestId, ...extra });
  let prepared = await prepare('request-one-0000001');
  check(prepared.result?.state === 'prepared' && writes === 0, 'prepare is read-only and returns first-party approval URL');
  const actionId = prepared.result.actionId;
  check((await prepare('request-one-0000001')).result.actionId === actionId, 'prepare idempotency key reuses exact action');
  check((await prepare('request-one-0000001', { slotId: 'two' })).error === 'IDEMPOTENCY_CONFLICT', 'idempotency key cannot change payload');
  check((await call('execute_booking_action', { gymId, actionId })).error === 'ACTION_APPROVAL_REQUIRED' && writes === 0, 'model or action ID cannot substitute for user approval');
  let approval = await approve(actionId, 'other@example.test');
  check(approval.tx.status !== 200 && writes === 0, 'another locally authenticated account cannot approve');
  clear(); const approvalTx = await signIn(await request(`/oauth/actions/${actionId}`));
  check(approvalTx.text.includes('&lt;script&gt;external') && !approvalTx.text.includes('<script>external'), 'approval escapes external class text');
  check((await request('/oauth/actions/decision', { ...approvalTx.fields, csrf: 'wrong', decision: 'allow' }, approvalTx.cookie)).status === 400, 'approval requires correct CSRF');
  check((await request('/oauth/actions/decision', { ...approvalTx.fields, decision: 'allow' }, approvalTx.cookie)).status === 200, 'actual first-party action approval succeeds');
  check((await request('/oauth/actions/decision', { ...approvalTx.fields, decision: 'allow' }, approvalTx.cookie)).status === 400, 'approval interaction is consumed once');
  let result = await call('execute_booking_action', { gymId, actionId });
  check(result.result?.state === 'succeeded' && writes === 1, 'approved action performs one shared-app booking');
  check((await call('execute_booking_action', { gymId, actionId })).result?.state === 'succeeded' && writes === 1, 'completed execution replay returns durable result without another write');
  clear(); let current = bookings[0];
  prepared = await call('prepare_booking_edit', { gymId, bookingId: current.bookingId, currentSlotId: 'one', slotId: 'two', requestId: 'request-edit-000001' });
  await approve(prepared.result.actionId);
  result = await call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  check(result.result?.state === 'succeeded' && bookings[0].slotId === 'two' && writes === 2, 'approved edit uses atomic shared-app swap');
  clear(); mode = 'fee';
  check((await call('prepare_booking_cancel', { gymId, bookingId: current.bookingId, requestId: 'request-fee-0000001' })).error === 'ACTION_UNAVAILABLE', 'monetary cancellation penalty cannot be approved');
  mode = 'success';
  prepared = await call('prepare_booking_cancel', { gymId, bookingId: current.bookingId, requestId: 'request-cancel-0001' });
  await approve(prepared.result.actionId);
  result = await call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  check(result.result?.state === 'succeeded' && bookings.length === 0 && writes === 3, 'approved personal cancellation performs exactly one write');
  clear(); prepared = await prepare('request-refusal-001'); await approve(prepared.result.actionId); mode = 'definite-refusal';
  result = await call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  check(result.result?.state === 'failed' && writes === 3, 'definitive provider refusal is failed without any retry');
  clear(); prepared = await prepare('request-unknown-001'); await approve(prepared.result.actionId); mode = 'uncertain';
  result = await call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  check(result.result?.state === 'unknown' && writes === 4, 'lost provider response is durably uncertain');
  check((await call('execute_booking_action', { gymId, actionId: prepared.result.actionId })).result?.state === 'unknown' && writes === 4, 'uncertain write is never resent');
  check((await prepare('replacement-after-timeout')).error === 'ACTION_UNCERTAIN' && writes === 4, 'new request key cannot bypass an unresolved uncertain action');
  result = await call('get_booking_action', { gymId, actionId: prepared.result.actionId });
  check(result.result?.state === 'succeeded' && result.result.result.reconciled && writes === 4, 'read-only reconciliation observes desired reservation without a write');
  mode = 'success'; bookings = []; require('./private-read-cache').invalidateGym(gymId);
  clear(); prepared = await prepare('request-policy-001'); await approve(prepared.result.actionId);
  access.setGym(gymId, false); access.setGym(gymId, true);
  check((await call('execute_booking_action', { gymId, actionId: prepared.result.actionId })).error === 'ACTION_CHANGED' && writes === 4, 'admin disable/re-enable invalidates earlier approval');
  clear(); prepared = await prepare('request-toggle-001'); await approve(prepared.result.actionId); await preference(false); await preference(true);
  check((await call('execute_booking_action', { gymId, actionId: prepared.result.actionId })).error === 'ACTION_CHANGED' && writes === 4, 'user off/on cannot resurrect an approval');
  clear(); prepared = await prepare('request-hop-000001'); await approve(prepared.result.actionId); mode = 'disable-during-hop';
  result = await call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  check(writes === 4 && db.db.prepare('SELECT state FROM mcp_actions WHERE id=?').get(prepared.result.actionId).state === 'failed', 'policy changes immediately before transport fail closed without a write');
  mode = 'success'; access.setWritePreference(userId, true);
  clear(); prepared = await prepare('request-restart-001'); await approve(prepared.result.actionId);
  const restartId = prepared.result.actionId;
  db.db.prepare("UPDATE mcp_actions SET state='executing',claimed_at=? WHERE id=?").run(Date.now() - 31000, restartId);
  const child = require('node:child_process').spawnSync(process.execPath, ['-e', `
    global.fetch=async()=>{throw Error('network forbidden')};
    const actions=require('./server/mcp/actions');
    actions.execute(${JSON.stringify(identity)},${JSON.stringify(restartId)},${JSON.stringify(configuration)}).then(r=>{
      if(r.state!=='executing')process.exitCode=1;
      require('./server/db').db.close();
    }).catch(()=>{process.exitCode=1});
  `], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  check(child.status === 0 && writes === 4, 'fresh process sees durable claim and never repeats a crashed execution');
  result = await call('get_booking_action', { gymId, actionId: restartId });
  check(result.result?.state === 'unknown' && writes === 4, 'crashed claim becomes uncertain and cannot be treated as a new approval');
  bookings = [{ bookingId: 'observed-after-restart', eventId: 'future-class', slotId: 'one' }];
  require('./private-read-cache').invalidateGym(gymId);
  check((await call('get_booking_action', { gymId, actionId: restartId })).result?.state === 'succeeded', 'external desired-outcome evidence can resolve restart uncertainty without resending');
  bookings = []; require('./private-read-cache').invalidateGym(gymId);
  db.db.prepare("UPDATE mcp_actions SET expires_at=? WHERE state IN ('prepared','approved')").run(Date.now() - 1);
  clear(); prepared = await prepare('request-unlink-0001'); await approve(prepared.result.actionId);
  db.db.prepare('DELETE FROM user_gyms WHERE user_id=? AND gym_id=?').run(userId, gymId);
  db.linkGym(userId, gymId);
  db.runWithGymContext(userId, gymId, () => db.updateUserJWT(userId, 'fixture-gym-session', new Date(Date.now()+600000).toISOString()));
  check((await call('execute_booking_action', { gymId, actionId: prepared.result.actionId })).error === 'ACTION_CHANGED' && writes === 4, 'unlink/relink never resurrects an action approval');
  clear(); prepared = await prepare('request-credential-1'); await approve(prepared.result.actionId); mode = 'credential-hop';
  await call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  check(writes === 4, 'credential renewal is blocked during guarded execution');
  mode = 'delayed';
  clear(); prepared = await prepare('request-race-0000001'); await approve(prepared.result.actionId);
  const firstExecution = call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  for (let n=0; n<100 && !writeStarted; n++) await new Promise(resolve => setTimeout(resolve, 5));
  check(writeStarted, 'fixture reaches one delayed mutation');
  const competing = await call('execute_booking_action', { gymId, actionId: prepared.result.actionId });
  releaseWrite();
  const firstResult = await firstExecution;
  check(competing.status === 429 && firstResult.result?.state === 'succeeded' && writes === 5, 'concurrent real HTTP execution is refused while the durable owner writes once');
  mode = 'success'; bookings = []; require('./private-read-cache').invalidateGym(gymId);
  clear(); prepared = await prepare('request-revoke-001'); await approve(prepared.result.actionId); store.revokeGrant(userId, identity.grantId);
  check((await call('execute_booking_action', { gymId, actionId: prepared.result.actionId })).status === 401 && writes === 5, 'revoked grant cannot execute an approved action');
  for (const [name, fn] of original) provider[name] = fn;
  console.log(`PASS MCP actions: ${checks} OAuth/approval/idempotency/reconciliation checks; mocked writes only`);
})().catch(err => { console.error('FAIL MCP actions:', err.message); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.db.close(); fs.rmSync(temp, { recursive: true, force: true });
});
