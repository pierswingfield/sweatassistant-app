// Real maintained OAuth engine and HTTP integration; no live provider traffic.
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);
process.env.JAB_BOXING_ENABLED = 'true';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const db = require('./db');
const store = require('./mcp/store');
const { mountAuthorization, loadAuthorizationConfiguration } = require('./mcp/authorization');
const { mountMcp } = require('./mcp/router');
const { verifier } = require('./mcp/auth');
const metrics = require('./metrics');
const access = require('./mcp/access');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-auth-'));
const origin = 'https://mcp.example.test';
const resource = `${origin}/mcp`;
const password = 'isolated-local-password';
let server, port, checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
function metricValue(name, labels) {
  const selector = `${name}{${Object.entries(labels).map(([key, value]) => `${key}="${value}"`).join(',')}}`;
  const line = metrics.render().split('\n').find(value => value.startsWith(selector));
  return line ? Number(line.slice(selector.length).trim()) : 0;
}
const hidden = html => Object.fromEntries([...html.matchAll(/type="hidden" name="([^"]+)" value="([^"]*)"/g)].map(m => [m[1], m[2]]));
const challengeVerifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(challengeVerifier).digest('base64url');
const parameters = { response_type: 'code', client_id: 'pilot', redirect_uri: 'https://client.example.test/callback', resource,
  scope: 'schedule:read account:read', state: 'state-bound-to-ai-client-123456', code_challenge: challenge, code_challenge_method: 'S256' };
let config;
async function http(url, { body, cookie, headers, method, ...options } = {}) {
  const r = await httpFetch(`http://127.0.0.1:${port}${url}`, { redirect: 'manual', method: method || (body ? 'POST' : 'GET'),
    headers: { host: 'mcp.example.test', ...(body ? { 'content-type': 'application/x-www-form-urlencoded', origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
    ...(body ? { body: typeof body === 'string' ? body : new URLSearchParams(body) } : {}), ...options });
  const text = await r.text(); let json; try { json = JSON.parse(text); } catch (_) { /* HTML */ }
  return { status: r.status, headers: r.headers, text, json };
}
function clearBudgets() { db.db.prepare('DELETE FROM mcp_budgets').run(); }
async function start(patch = {}) {
  const response = await http(`/oauth/authorize?${new URLSearchParams({ ...parameters, ...patch })}`);
  return { ...response, cookie: response.headers.get('set-cookie')?.split(';')[0], fields: hidden(response.text) };
}
async function login(tx, override = {}) {
  const r = await http('/oauth/login', { cookie: tx.cookie, body: { ...tx.fields, email: 'oauth@example.test', password, ...override } });
  return { ...r, cookie: tx.cookie, fields: hidden(r.text) };
}
async function consent(tx, patch = {}) {
  const body = new URLSearchParams({ ...tx.fields, decision: 'allow', ...patch });
  if (!Object.hasOwn(patch, 'scopes')) body.append('scopes', 'schedule:read');
  const r = await http('/oauth/consent', { cookie: tx.cookie, body: body.toString() });
  return { ...r, code: r.headers.get('location') ? new URL(r.headers.get('location')).searchParams.get('code') : null };
}
async function issue() { return consent(await login(await start())); }
async function exchange(code, patch = {}) { return http('/oauth/token', { body: { grant_type: 'authorization_code', client_id: 'pilot', code, code_verifier: challengeVerifier, redirect_uri: parameters.redirect_uri, resource, ...patch } }); }
async function refresh(value, patch = {}) { return http('/oauth/token', { body: { grant_type: 'refresh_token', client_id: 'pilot', refresh_token: value, resource, ...patch } }); }
(async () => {
  const jose = await import('jose');
  const pair = await jose.generateKeyPair('ES256', { extractable: true });
  const privateJwk = { ...await jose.exportJWK(pair.privateKey), kid: 'auth-test', alg: 'ES256' };
  const publicJwk = { ...await jose.exportJWK(pair.publicKey), kid: 'auth-test', use: 'sig' };
  config = { enabled: true, issuer: `${origin}/`, resource, host: 'mcp.example.test', origins: [origin], providerReads: false, abuseProtection: true,
    jwksFile: path.join(temp, 'jwks.json') };
  fs.writeFileSync(config.jwksFile, JSON.stringify({ keys: [publicJwk] }));
  const privateFile = path.join(temp, 'private.json'); fs.writeFileSync(privateFile, JSON.stringify(privateJwk));
  const clientsFile = path.join(temp, 'clients.json');
  fs.writeFileSync(clientsFile, JSON.stringify({ clients: [
    { id: 'pilot', name: 'Pilot AI', public: true, redirectUris: [parameters.redirect_uri] },
    { id: 'confidential', name: 'Confidential AI', public: false, secretHash: crypto.createHash('sha256').update('client-secret-test').digest('hex'), redirectUris: [parameters.redirect_uri] },
  ] }));
  const env = { MCP_AUTH_SERVER_ENABLED: 'true', MCP_SIGNING_KEY_FILE: privateFile, MCP_CLIENTS_FILE: clientsFile };
  assert.throws(() => loadAuthorizationConfiguration({ ...config, issuer: 'https://untrusted.example/' }, env)); checks++;
  const local = loadAuthorizationConfiguration(config, env);
  const accountId = db.createAccount('oauth@example.test', password);
  const gymId = db.getGyms().find(g => g.enabled).id;
  db.linkGym(accountId, gymId);
  const app = express(); mountAuthorization(app, config, { config: local }); mountMcp(app, config);
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); port = server.address().port;
  check((await http('/.well-known/oauth-authorization-server')).json.code_challenge_methods_supported.join() === 'S256', 'S256-only discovery');
  for (const patch of [{ redirect_uri: `${parameters.redirect_uri}/evil` }, { redirect_uri: 'https://evil.example/' }, { resource: 'https://evil.example/mcp' },
    { state: '' }, { code_challenge_method: 'plain' }, { code_challenge: '' }, { scope: 'booking:write' }, { client_id: 'unknown' }, { scope: 'schedule:read schedule:read' }]) {
    const r = await start(patch); check(r.status === 400 && !r.headers.has('location'), 'untrusted authorization rejected without redirect');
  }
  const localizedStart = await start({ ui_locales: 'en-US', client_hint: 'ChatGPT' });
  check(localizedStart.status === 200 && localizedStart.text.includes('Sign in to your account'), 'OpenAI ui_locales authorization parameter is accepted');
  const localizedRequest = JSON.parse(db.db.prepare('SELECT request_json FROM mcp_oauth_interactions WHERE id = ?').get(localizedStart.fields.interaction).request_json);
  check(!Object.hasOwn(localizedRequest, 'ui_locales') && !Object.hasOwn(localizedRequest, 'client_hint'), 'ignored authorization extensions are not persisted');
  const duplicateKnown = new URLSearchParams(parameters); duplicateKnown.append('client_id', 'pilot');
  check((await http(`/oauth/authorize?${duplicateKnown}`)).status === 400, 'duplicate recognized authorization parameter rejected');
  const duplicateExtension = new URLSearchParams({ ...parameters, ui_locales: 'en-US' }); duplicateExtension.append('ui_locales', 'en-GB');
  check((await http(`/oauth/authorize?${duplicateExtension}`)).status === 400, 'duplicate authorization extension rejected');
  check((await http('/oauth/authorize?client_id%5B%5D=pilot')).status === 400, 'array-shaped client id cannot satisfy required scalar');
  const tooMany = new URLSearchParams(parameters); for (let i = 0; i < 9; i++) tooMany.append(`extension${i}`, 'x');
  check((await http(`/oauth/authorize?${tooMany}`)).status === 400, 'authorization parameter count bounded');
  const tooLong = new URLSearchParams(parameters); tooLong.set('extension', 'x'.repeat(8200));
  check((await http(`/oauth/authorize?${tooLong}`)).status === 400, 'authorization query byte length bounded');
  check((await start()).headers.get('set-cookie').includes('Secure; SameSite=Lax'), 'secure host-only session cookie');
  let tx = await start();
  check((await http('/oauth/login', { body: { ...tx.fields, email: 'oauth@example.test', password } })).status === 400, 'cookie required for account proof');
  check((await http('/oauth/login', { cookie: tx.cookie, headers: { origin: 'https://evil.example' }, body: { ...tx.fields, email: 'oauth@example.test', password } })).status === 403, 'login CSRF origin rejected');
  check((await login(tx, { csrf: 'fake' })).status === 400, 'login CSRF token rejected');
  check((await login(tx, { password: 'wrong' })).text.includes('Invalid email or password'), 'only local account password proves identity');
  clearBudgets();
  tx = await login(await start());
  check(tx.text.includes('current and future') && !tx.text.includes('name="gyms"'), 'new consent explicitly covers all linked gyms without a gym selector');
  check(tx.headers.get('content-security-policy').includes('form-action \'self\' https://client.example.test'), 'consent permits only registered cross-origin callback origin');
  check(tx.headers.get('referrer-policy') === 'same-origin', 'navigation POST preserves first-party Origin');
  check(tx.text.includes('Connect Pilot AI') && tx.text.includes('Permissions') && !tx.text.includes('checked'), 'explicit unchecked scope/gym consent');
  const denied = await http('/oauth/consent', { cookie: tx.cookie, body: { ...tx.fields, decision: 'deny' } });
  check(denied.status === 303 && new URL(denied.headers.get('location')).searchParams.get('state') === parameters.state, 'denial preserves client state');
  check(store.listGrants(accountId).length === 0, 'denial creates no grant');
  tx = await login(await start());
  const approved = await consent(tx);
  check(approved.status === 303 && !!approved.code, 'consent invokes maintained authorization engine');
  check(new URL(approved.headers.get('location')).searchParams.get('state') === parameters.state, 'success preserves state');
  check((await consent(tx)).status === 400, 'consent interaction one use');
  check(db.db.prepare('SELECT token_hash FROM mcp_oauth_codes').get().token_hash !== approved.code, 'authorization codes stored hashed');
  let tokens = await exchange(approved.code);
  check(tokens.status === 200 && tokens.json.access_token && tokens.json.refresh_token, 'real code exchange issues token pair');
  const verify = verifier(config);
  let identity = await verify(tokens.json.access_token);
  check(identity.scopes.join() === 'schedule:read' && identity.subject === `account:${accountId}`, 'consent subset and local account bound into verified JWT');
  check(store.listGrants(accountId).find(g => g.id === identity.grantId).all_linked === 1, 'new OAuth grant persists all-linked consent');
  const extraGym = db.getGyms().find(g => g.enabled && g.id !== gymId).id;
  const narrowId = store.createGrant({ userId: accountId, issuer: config.issuer, subject: identity.subject, clientId: 'pilot', scopes: ['schedule:read'], gymIds: [gymId], expiresAt: Date.now() + 60000, consentReference: 'legacy-test' });
  const narrowIdentity = { ...identity, grantId: narrowId };
  db.linkGym(accountId, extraGym);
  check(store.authorize(identity).gyms.includes(extraGym), 'explicit all-linked grant sees newly attached gym');
  check(!store.authorize(narrowIdentity).gyms.includes(extraGym), 'existing narrow grant never widens');
  access.setGym(extraGym, false);
  check(!store.authorize(identity).gyms.includes(extraGym), 'all-linked consent respects immediate administrator gym disable');
  access.setGym(extraGym, true);
  const extraLink = db.getUserGym(accountId, extraGym);
  db.db.prepare('DELETE FROM user_gyms WHERE id=?').run(extraLink.id);
  check(!store.authorize(identity).gyms.includes(extraGym), 'unlink immediately removes all-linked access');
  db.db.prepare('DELETE FROM user_gyms WHERE user_id=? AND gym_id=?').run(accountId, gymId);
  db.linkGym(accountId, gymId);
  check(store.authorize(identity).gyms.includes(gymId) && !store.authorize(narrowIdentity).gyms.includes(gymId), 'relinked gym joins explicit all-linked grant but cannot reactivate old snapshot');
  store.revokeGrant(accountId, narrowId);
  check((await exchange(approved.code)).status === 400, 'authorization code replay rejected');
  check(db.db.prepare('SELECT token_hash FROM mcp_oauth_refresh').get().token_hash !== tokens.json.refresh_token, 'refresh tokens stored hashed');
  const rotated = await refresh(tokens.json.refresh_token);
  check(rotated.status === 200 && rotated.json.refresh_token !== tokens.json.refresh_token, 'refresh rotation issues new value');
  check((await refresh(tokens.json.refresh_token)).status === 400, 'refresh replay rejected');
  check((await refresh(rotated.json.refresh_token)).status === 400, 'refresh replay revokes descendants');
  await assert.rejects(() => verify(rotated.json.access_token)); checks++;
  clearBudgets();
  let code = (await issue()).code;
  check((await exchange(code, { code_verifier: 'x'.repeat(43) })).status === 400, 'PKCE mismatch rejected');
  check((await exchange(code)).status === 400, 'bad PKCE attempt consumes code');
  code = (await issue()).code;
  check((await exchange(code, { redirect_uri: `${parameters.redirect_uri}/other` })).status === 400, 'code exact redirect enforced');
  code = (await issue()).code;
  check((await exchange(code, { resource: `${origin}/other` })).status === 400, 'token resource substitution rejected');
  check((await exchange(code, { client_id: 'confidential' })).status === 400, 'confidential client requires secret');
  check((await http('/oauth/token', { body: { grant_type: 'password', client_id: 'pilot', resource, username: 'oauth@example.test', password } })).status === 400, 'password grant unavailable');
  const token4xxBeforeVariants = metricValue('mcp_http_requests_total', { route: 'oauth_token', method: 'post', status: '4xx' });
  const invalidGrant = { grant_type: 'password', client_id: 'pilot', resource };
  check((await http('/oauth/TOKEN', { body: invalidGrant })).status === 400 &&
    (await http('/oauth/token/', { body: invalidGrant })).status === 400 &&
    metricValue('mcp_http_requests_total', { route: 'oauth_token', method: 'post', status: '4xx' }) === token4xxBeforeVariants + 2,
  'OAuth token case/trailing-slash route variants are counted once');
  clearBudgets();
  tokens = await exchange((await issue()).code);
  check(tokens.status === 200, 'new connection after revoked family');
  const conn = await http('/oauth/connections');
  tx = await login({ ...conn, cookie: conn.headers.get('set-cookie').split(';')[0], fields: hidden(conn.text) });
  check(tx.text.includes('AI connections') && tx.text.includes('Last used') && tx.text.includes('Revoke Pilot AI'), 'connection management shows grants, expiry and revoke');
  check(tx.text.includes('Allow AI booking changes') && !tx.text.includes('value="true" checked') && !access.writePreference(accountId).enabled, 'single user-facing booking-change setting defaults off');
  check(tx.text.includes('not activated on this deployment'), 'preference does not imply deployment activation');
  const preferenceFields = { interaction: tx.fields.interaction, csrf: tx.fields.csrf };
  let saved = await http('/oauth/connections/writes', { cookie: tx.cookie, body: { ...preferenceFields, writesEnabled: 'true' } });
  check(saved.status === 200 && access.writePreference(accountId).enabled && access.writePreference(accountId).revision === 1, 'first-party authenticated preference persists enable with revision');
  check((await http('/oauth/connections/writes', { cookie: tx.cookie, body: { ...preferenceFields, csrf: 'bad' } })).status === 400 && access.writePreference(accountId).enabled, 'preference rejects bad CSRF without changing value');
  check((await http('/oauth/connections/writes', { cookie: tx.cookie, headers: { origin: 'https://evil.example' }, body: preferenceFields })).status === 403, 'preference rejects cross-origin update');
  check((await http('/oauth/connections/writes', { cookie: tx.cookie, body: { ...preferenceFields, writesEnabled: 'false' } })).status === 400, 'preference rejects non-checkbox scalar');
  saved = await http('/oauth/connections/writes', { cookie: tx.cookie, body: preferenceFields });
  check(saved.status === 200 && !access.writePreference(accountId).enabled && access.writePreference(accountId).revision === 2, 'unchecked setting disables and advances revision for prepared-action invalidation');
  const oldPolicy = access.policyVersion('account', accountId);
  access.setAccount(accountId, false); access.setAccount(accountId, true);
  check(access.policyVersion('account', accountId) === oldPolicy + 2, 'administrator disable and re-enable retain policy revision history');
  const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' };
  for (let n=0;n<20;n++) await http('/mcp', { headers: { ...mcpHeaders, authorization: `Bearer invalid-${n}` }, body: JSON.stringify({jsonrpc:'2.0',id:n,method:'ping'}) });
  check((await http('/mcp', { headers:mcpHeaders, body:JSON.stringify({jsonrpc:'2.0',id:100,method:'ping'}) })).status===429, 'anonymous abusive IP receives temporary ban');
  check((await http('/mcp', { headers:{...mcpHeaders,authorization:`Bearer ${tokens.json.access_token}`},body:JSON.stringify({jsonrpc:'2.0',id:101,method:'ping'}) })).status===200, 'legitimate authenticated user sharing abusive egress remains usable');
  check((await http('/.well-known/oauth-protected-resource/mcp')).status===200, 'discovery is not blocked by a shared anonymous-IP ban');
  const grantId = (await verify(tokens.json.access_token)).grantId;
  const rev = await http('/oauth/connections/revoke', { cookie: tx.cookie, body: { ...tx.fields, grant: grantId } });
  check(rev.status === 200 && rev.text.includes('Access revoked'), 'first-party revoke succeeds');
  await assert.rejects(() => verify(tokens.json.access_token)); checks++;
  const refresh4xxBefore = metricValue('mcp_http_requests_total', { route: 'oauth_token', method: 'post', status: '4xx' });
  check((await refresh(tokens.json.refresh_token)).status === 400, 'revocation rejects refresh immediately');
  check(metricValue('mcp_http_requests_total', { route: 'oauth_token', method: 'post', status: '4xx' }) === refresh4xxBefore + 1,
    'revoked refresh rejection is counted at the early OAuth boundary');
  clearBudgets();
  let writeTx = await login(await start({ scope: 'bookings:write' }));
  const writeConsent = await consent(writeTx, { scopes: 'bookings:write' });
  const writePair = await exchange(writeConsent.code);
  check(writePair.status === 200 && (await verify(writePair.json.access_token)).scopes.join() === 'bookings:write', 'booking-write permission requires explicit separate OAuth consent');
  check(!access.writePreference(accountId).enabled, 'granting write scope never enables user setting');
  clearBudgets();
  const emptyId = db.createAccount('gym-less@example.test', password);
  let emptyTx = await login(await start(), { email: 'gym-less@example.test' });
  check(emptyTx.text.includes('No gym is linked yet'), 'gym-less account can explicitly consent to future linked access');
  const emptyPair = await exchange((await consent(emptyTx)).code);
  const emptyIdentity = await verify(emptyPair.json.access_token);
  check(store.authorize(emptyIdentity).gyms.length === 0, 'gym-less grant invents no gym');
  db.linkGym(emptyId, gymId);
  check(store.authorize(emptyIdentity).gyms.join() === gymId, 'explicit future-linked consent activates only after real link');
  clearBudgets();
  let legacyTx = await start();
  const oldRequest = JSON.parse(db.db.prepare('SELECT request_json FROM mcp_oauth_interactions WHERE id=?').get(legacyTx.fields.interaction).request_json);
  delete oldRequest.gymMode;
  db.db.prepare('UPDATE mcp_oauth_interactions SET request_json=? WHERE id=?').run(JSON.stringify(oldRequest), legacyTx.fields.interaction);
  legacyTx = await login(legacyTx);
  check(legacyTx.text.includes('name="gyms"') && !legacyTx.text.includes('current and future'), 'pending legacy consent retains gym-selection disclosure');
  const legacyConsent = await consent(legacyTx, { gyms: gymId });
  const legacyPair = await exchange(legacyConsent.code);
  const legacyIdentity = await verify(legacyPair.json.access_token);
  check(legacyPair.status === 200 && store.listGrants(accountId).find(g => g.id === legacyIdentity.grantId).all_linked === 0, 'pending legacy consent remains a limited grant');
  clearBudgets();
  code = (await consent(await login(await start({ client_id: 'confidential' })))).code;
  const secretPair = await exchange(code, { client_id: 'confidential', client_secret: 'client-secret-test' });
  check(secretPair.status === 200, 'confidential preregistered client authenticates to token endpoint');
  code = (await issue()).code;
  const race = await Promise.all([exchange(code), exchange(code)]);
  check(race.filter(r => r.status === 200).length === 1 && race.some(r => r.status === 400), 'atomic authorization code consumption under concurrent exchange');
  clearBudgets();
  tokens = await exchange((await issue()).code);
  const refreshRace = await Promise.all([refresh(tokens.json.refresh_token), refresh(tokens.json.refresh_token)]);
  check(refreshRace.filter(r => r.status === 200).length <= 1 && refreshRace.some(r => r.status === 400), 'concurrent refresh cannot issue two successors');
  await assert.rejects(() => verify(tokens.json.access_token)); checks++;
  for (const r of refreshRace.filter(r => r.status === 200)) { await assert.rejects(() => verify(r.json.access_token)); checks++; }
  clearBudgets();
  code = (await issue()).code;
  db.db.prepare('UPDATE mcp_oauth_codes SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, crypto.createHash('sha256').update(code).digest('hex'));
  check((await exchange(code)).status === 400, 'expired authorization code rejected');
  clearBudgets();
  tx = await login(await start()); db.setAccountPassword(accountId, 'new-local-password');
  check((await consent(tx)).status === 400, 'password change invalidates in-progress consent');
  clearBudgets();
  tx = await start();
  for (let i = 0; i < 10; i++) await login(tx, { password: 'wrong' });
  check((await login(tx)).status === 429, 'account proof brute-force budget enforced');
  console.log(`PASS MCP authorization: ${checks} security and protocol checks`);
})().catch(err => { console.error('FAIL MCP authorization:', err.message); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(r => server.close(r));
  fs.rmSync(temp, { recursive: true, force: true });
});

function httpFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request(url, { method: options.method || 'GET', headers: options.headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    if (options.body) req.write(String(options.body));
    req.end();
  });
}
