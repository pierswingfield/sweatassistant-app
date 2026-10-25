'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
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
  const key = 'x'.repeat(48); let captured; let stall = false; let releaseStalled; let stalledSignal;
  const server = createServer({ gatewayKey: key, fetchImpl: async (url, options) => {
    captured = { url: String(url), options };
    if (stall) return new Promise((resolve, reject) => {
      stalledSignal = options.signal;
      releaseStalled = () => resolve(new Response('released'));
      options.signal.addEventListener('abort', () => reject(options.signal.reason || new Error('aborted')), { once: true });
    });
    return new Response('login', { status: 302, headers: { location: login } });
  }, deadlineMs: 200 });
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

    // A client may authenticate and then never finish its declared body. The
    // deadline must end parsing, return a bounded response and release the slot.
    const beforePartial = captured;
    const partialStatus = await new Promise(resolve => {
      let done = false;
      const req = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000', 'x-stage-egress-key': key } }, response => {
        response.resume(); response.on('end', () => finish(response.statusCode));
      });
      const timer = setTimeout(() => finish(null), 600);
      function finish(status) { if (done) return; done = true; clearTimeout(timer); req.destroy(); resolve(status); }
      req.on('error', () => finish(null)); req.write('{');
    });
    assert.equal(partialStatus, 400, 'incomplete body is rejected within the gateway deadline');
    assert.equal(captured, beforePartial, 'incomplete body never starts upstream');
    const valid = () => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key }, body: JSON.stringify({ url: authorize.toString(), method: 'GET' }) });
    assert.equal((await valid()).status, 200, 'incomplete-body timeout releases the request slot');

    const partialDisconnect = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1000', 'x-stage-egress-key': key } });
    partialDisconnect.on('error', () => {}); partialDisconnect.write('{');
    await new Promise(resolve => setTimeout(resolve, 20)); partialDisconnect.destroy();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await valid()).status, 200, 'disconnect before complete body releases the slot');
    const beforeOversize = captured;
    const oversized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key }, body: 'x'.repeat(256 * 1024 + 1) });
    assert.equal(oversized.status, 400, 'body byte cap returns a bounded rejection');
    assert.equal(captured, beforeOversize, 'oversized body never starts upstream');
    assert.equal((await valid()).status, 200, 'body byte-cap rejection releases the slot');

    // The request body is complete before the client disconnects. This must
    // abort a stalled upstream body promptly and release the broker's single
    // request slot, even though IncomingMessage.aborted will not fire here.
    stall = true;
    const body = JSON.stringify({ url: 'https://jabboxingclub.marianatek.com/api/customer/v1/me/account', method: 'GET' });
    const disconnected = http.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key, 'content-length': Buffer.byteLength(body) } });
    disconnected.on('error', () => {});
    disconnected.end(body);
    for (let i = 0; i < 100 && !stalledSignal; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const signal = stalledSignal;
    assert.ok(signal, 'stalled upstream started after complete request body');
    disconnected.destroy();
    const abortedPromptly = await Promise.race([
      new Promise(resolve => signal.addEventListener('abort', () => resolve(true), { once: true })),
      new Promise(resolve => setTimeout(() => resolve(false), 350)),
    ]);
    if (!abortedPromptly) releaseStalled(); // let the pre-fix server unwind cleanly
    assert.equal(abortedPromptly, true, 'client disconnect aborts the upstream request promptly');
    stall = false;
    const afterDisconnect = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key }, body: JSON.stringify({ url: authorize.toString(), method: 'GET' }) });
    assert.equal(afterDisconnect.status, 200, 'disconnect releases the single in-flight request slot');

    // Deadline abort also covers a stalled response body and releases the slot.
    stall = true;
    const deadlineResponse = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key }, body: JSON.stringify({ url: authorize.toString(), method: 'GET' }) });
    assert.equal(deadlineResponse.status, 502);
    assert.equal(stalledSignal.aborted, true, 'gateway deadline aborts the stalled upstream');
    stall = false;
    const afterDeadline = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-stage-egress-key': key }, body: JSON.stringify({ url: authorize.toString(), method: 'GET' }) });
    assert.equal(afterDeadline.status, 200, 'deadline releases the single in-flight request slot');
    process.stdout.write('stage JAB gateway allowlist and deny-by-default checks passed\n');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(err => { console.error(err); process.exitCode = 1; });
