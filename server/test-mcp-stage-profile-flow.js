'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'fixture-encryption-key-for-profile-flow';
process.env.MCP_STAGE_JAB_PROFILE_ONLY = 'true';
process.env.MCP_PROVIDER_READS_ENABLED = 'false';
process.env.MCP_STAGE_JAB_GATEWAY_KEY = 'fixture-gateway-key-at-least-32-bytes';

const gym = require('./gyms.config').getGymConfig('jab-boxing');
const { createServer } = require('./mcp-stage-jab-egress');
const { getProvider } = require('./providers');
const challenge = 'c'.repeat(43);
const authorize = new URL(`${gym.oauthBaseUrl}/authorize/`);
for (const [key, value] of Object.entries({
  client_id: gym.clientId,
  scope: gym.scope,
  response_type: 'code',
  redirect_uri: gym.redirectUri,
  code_challenge: challenge,
  code_challenge_method: 'S256',
})) authorize.searchParams.set(key, value);
const loginUrl = new URL('/auth/login/', gym.oauthBaseUrl);
loginUrl.searchParams.set('next', `${authorize.pathname}${authorize.search}`);

function responseWithCookies(body, status, headers, cookies) {
  const h = new Headers(headers);
  for (const cookie of cookies || []) h.append('set-cookie', cookie);
  return new Response(body, { status, headers: h });
}

async function main() {
  const observed = [];
  let authorizeCount = 0;
  const fetchImpl = async (url, options) => {
      const target = new URL(url);
      const method = options.method || 'GET';
      observed.push({ method, path: target.pathname });
      if (target.pathname === '/o/authorize/' && method === 'GET') {
        authorizeCount++;
        if (authorizeCount === 1) {
          return responseWithCookies('', 302, { location: loginUrl.toString() }, [
            'preauth=one; Path=/; Secure; HttpOnly',
            'flow=two; Path=/; Secure; HttpOnly',
          ]);
        }
        return responseWithCookies('', 302, {
          location: `${gym.redirectUri}?code=fixture-code`,
        }, ['flow=three; Path=/; Secure; HttpOnly']);
      }
      if (target.pathname === '/auth/login/' && method === 'GET') {
        assert.deepEqual(options.headers.cookie.split('; ').map(x => x.split('=')[0]).sort(), ['flow', 'preauth']);
        return responseWithCookies(
          '<form><input type="hidden" name="csrfmiddlewaretoken" value="fixture-csrf"></form>',
          200,
          { 'content-type': 'text/html' },
          ['csrftoken=csrf-cookie; Path=/; Secure; HttpOnly', 'sessionid=login-session; Path=/; Secure; HttpOnly'],
        );
      }
      if (target.pathname === '/auth/login/' && method === 'POST') {
        assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
        assert.ok(options.headers.referer.startsWith('https://jabboxingclub.marianatek.com/auth/login/'));
        const cookieNames = options.headers.cookie.split('; ').map(x => x.split('=')[0]).sort();
        assert.deepEqual(cookieNames, ['csrftoken', 'flow', 'preauth', 'sessionid']);
        const form = new URLSearchParams(options.body);
        assert.deepEqual([...form.keys()], ['csrfmiddlewaretoken', 'username', 'password', 'next']);
        assert.equal(form.get('csrfmiddlewaretoken'), 'fixture-csrf');
        assert.equal(form.get('username'), 'fixture@example.test');
        assert.equal(form.get('password'), 'fixture-password');
        assert.equal(form.get('next'), loginUrl.searchParams.get('next'));
        return responseWithCookies('', 302, { location: loginUrl.searchParams.get('next') }, [
          'after-login=ok; Path=/; Secure; HttpOnly',
        ]);
      }
      if (target.pathname === '/o/token/' && method === 'POST') {
        const form = new URLSearchParams(options.body);
        assert.deepEqual([...form.keys()], ['grant_type', 'code', 'client_id', 'redirect_uri', 'code_verifier']);
        assert.equal(form.get('code'), 'fixture-code');
        assert.equal(form.get('code_verifier').length, 43);
        return new Response(JSON.stringify({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.pathname === '/api/customer/v1/me/account' && method === 'GET') {
        assert.equal(options.headers.authorization, 'Bearer fixture-access');
        return new Response(JSON.stringify({ id: 'fixture-user', email: 'fixture@example.test' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fixture request ${method} ${target.pathname}`);
    };
  const server = createServer({
    gatewayKey: process.env.MCP_STAGE_JAB_GATEWAY_KEY,
    fetchImpl,
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousFetch = global.fetch;
  process.env.MCP_STAGE_JAB_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
  global.fetch = previousFetch;
  try {
    const result = await getProvider('jab-boxing').login({ email: 'fixture@example.test', password: 'fixture-password' });
    assert.equal(result.session.accessToken, 'fixture-access');
    assert.equal(result.session.refreshToken, 'fixture-refresh');
    assert.deepEqual(observed.map(x => `${x.method} ${x.path}`), [
      'GET /o/authorize/', 'GET /auth/login/', 'POST /auth/login/',
      'GET /o/authorize/', 'POST /o/token/', 'GET /api/customer/v1/me/account',
    ]);
    const expected = observed.map(x => `${x.method} ${x.path}`);
    observed.length = 0;
    authorizeCount = 0;

    // Control: the same adapter flow in ordinary mode uses native fetch and
    // never contacts the stage broker. This protects normal deployments.
    process.env.MCP_STAGE_JAB_PROFILE_ONLY = 'false';
    global.fetch = async (url, options) => fetchImpl(url, options);
    const direct = await getProvider('jab-boxing').login({ email: 'fixture@example.test', password: 'fixture-password' });
    assert.equal(direct.session.accessToken, 'fixture-access');
    assert.deepEqual(observed.map(x => `${x.method} ${x.path}`), expected);
    process.stdout.write('synthetic MarianaTek login/profile flow passed through stage gateway; normal-mode control passed without broker\n');
  } finally {
    global.fetch = previousFetch;
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
