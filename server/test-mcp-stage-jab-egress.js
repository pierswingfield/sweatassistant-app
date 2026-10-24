'use strict';
const assert = require('node:assert/strict');
const { assertAllowedProfileRequest } = require('./mcp/jab-profile-policy');
const { createServer } = require('./mcp-stage-jab-egress');
const gym = require('./gyms.config').getGymConfig('jab-boxing');
const challenge = 'a'.repeat(43);
const authorize = new URL('https://jabboxingclub.marianatek.com/o/authorize/');
for (const [k, v] of Object.entries({ client_id: gym.clientId, scope: gym.scope, response_type: 'code', redirect_uri: gym.redirectUri, code_challenge: challenge, code_challenge_method: 'S256' })) authorize.searchParams.set(k, v);
const next = encodeURIComponent(authorize.pathname + authorize.search);
const login = `https://jabboxingclub.marianatek.com/auth/login/?next=${next}`;
assert.equal(assertAllowedProfileRequest(authorize).pathname, '/o/authorize/');
assertAllowedProfileRequest(login);
assertAllowedProfileRequest(login, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrfmiddlewaretoken: 'csrf', username: 'u', password: 'p', next: `${authorize.pathname}${authorize.search}` }).toString() });
assertAllowedProfileRequest('https://jabboxingclub.marianatek.com/o/token/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: 'one-use', client_id: gym.clientId, redirect_uri: gym.redirectUri, code_verifier: 'b'.repeat(43) }).toString() });
assertAllowedProfileRequest('https://jabboxingclub.marianatek.com/api/customer/v1/me/account', { headers: { authorization: 'Bearer x' } });
for (const [url, opts] of [
  ['https://evil.example/o/authorize/', {}],
  ['http://jabboxingclub.marianatek.com/o/authorize/', {}],
  ['https://jabboxingclub.marianatek.com/api/customer/v1/classes', {}],
  ['https://jabboxingclub.marianatek.com/api/customer/v1/me/account?expand=bookings', {}],
  [authorize.toString() + '&extra=1', {}],
  ['https://jabboxingclub.marianatek.com/o/token/', { method: 'POST', body: 'grant_type=refresh_token&refresh_token=x' }],
  ['https://jabboxingclub.marianatek.com/auth/login/', { method: 'POST', body: 'username=u&password=p' }],
]) assert.throws(() => assertAllowedProfileRequest(url, opts));

(async () => {
  const key = 'x'.repeat(48); let captured;
  const server = createServer({ gatewayKey: key, fetchImpl: async (url, options) => {
    captured = { url: String(url), options };
    return new Response('login', { status: 302, headers: { location: login } });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/profile-request`;
  try {
    const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': 'bad' }, body: '{}' });
    assert.equal(unauthorized.status, 404);
    const denied = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key }, body: JSON.stringify({ url: 'https://jabboxingclub.marianatek.com/api/customer/v1/bookings', method: 'GET' }) });
    assert.equal(denied.status, 403);
    const accepted = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key }, body: JSON.stringify({ url: authorize.toString(), method: 'GET', headers: { cookie: 'private=1', authorization: 'secret' } }) });
    const result = await accepted.json();
    assert.equal(result.status, 302);
    assert.equal(captured.options.redirect, 'manual');
    assert.equal(captured.options.headers.cookie, 'private=1');
    assert.equal(captured.options.headers.authorization, 'secret');
    assert.equal(JSON.stringify(result).includes('secret'), false);
    process.stdout.write('stage JAB gateway allowlist and deny-by-default checks passed\n');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(err => { console.error(err); process.exitCode = 1; });
