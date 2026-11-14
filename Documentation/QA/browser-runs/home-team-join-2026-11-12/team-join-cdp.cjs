// Local-only regression loop. Attaches to the existing user's Chrome tab; never launches a browser.
// TAB_ID=<one shared QA tab> node <this file>. Server3000 + Vite5173 must be running.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ORIGIN = 'http://localhost:5173';
const API = 'http://localhost:3000';
const out = __dirname;
const PASSWORD = 'LocalFixture123!';
const run = Date.now();
const target = process.env.TAB_ID;
if (!target) throw new Error('Set TAB_ID to the one shared local QA Chrome tab.');
let serial = 0;
const pending = new Map();
const ws = new WebSocket(`ws://127.0.0.1:9222/devtools/page/${target}`);
ws.addEventListener('message', ({ data }) => {
  const r = JSON.parse(data);
  if (r.id) { const p = pending.get(r.id); pending.delete(r.id); r.error ? p.reject(r.error) : p.resolve(r.result); }
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + r.exceptionDetails.exception?.description);
  return r.result.value;
}
async function until(expression, label) {
  for (let n = 0; n < 60; n++) {
    if (await evaluate(expression)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Timed out: ' + label + ' ' + JSON.stringify(await evaluate(`({url:location.pathname,step:document.querySelector('#app-onboarding-container').dataset.step,text:document.body.textContent.slice(-700)})`)));
}
async function request(url, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  const res = await fetch(API + url, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await res.json();
  assert.ok(res.ok, `${res.status} ${JSON.stringify(json)}`);
  return json;
}
const signup = name => request('/api/auth/signup', { body: { email: `${name}-${run}@example.test`, password: PASSWORD, policyAcceptance: { accepted: true, termsVersion: '2026-11-09', privacyVersion: '2026-11-09' } } });
async function navigate(url) { await cdp('Page.navigate', { url: ORIGIN + url }); }
async function reset(session = null) {
  await cdp('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'cache_storage,indexeddb,service_workers' });
  await evaluate(`localStorage.clear(); ${session ? `localStorage.setItem('appLocalToken',${JSON.stringify(session.token)});localStorage.setItem('appUserId',${JSON.stringify(String(session.user.id))});` : ''}`);
}
async function shot(name) {
  await cdp('Page.bringToFront');
  await new Promise(r => setTimeout(r, 350));
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
}
const welcome = `getComputedStyle(document.querySelector('#app-onboarding-container')).display === 'none' && !!document.querySelector('.tm-invite-card') && document.querySelector('.tm-invite-card').textContent.includes('Request to join')`;
const results = [];
const pass = name => { results.push(name); console.log('PASS ' + name); };
(async () => {
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  await cdp('Page.bringToFront');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await navigate('/');
  await until(`!!document.querySelector('#app-onboarding-container')`, 'app loaded');
  const captain = await signup('captain');
  const member = await signup('returning');
  const created = await request('/api/teams', { token: captain.token, body: { name: 'Join Journey Fixture', emoji: '🌟' } });
  const invite = created.inviteToken;
  const invitePath = '/t/' + invite;
  await reset(member);
  await navigate(invitePath);
  await until(welcome, 'logged-in invitation welcome');
  await shot('team-authenticated-welcome');
  pass('existing logged-in account skips all setup and reaches invitation welcome');

  await reset();
  await navigate(invitePath);
  await until(`!!document.querySelector('.app-onb-team-preview')?.textContent.includes('Sign in or join Dibs to join Join Journey Fixture!')`, 'signed-out Team preview');
  const installManifest = await evaluate(`document.querySelector('[rel=manifest]').getAttribute('href')`);
  assert.match(installManifest, /^\/api\/teams\/install-manifest\//);
  await shot('team-signed-out-preview');
  pass('signed-out first screen previews Team and prepares opaque install manifest');
  await evaluate(`document.querySelector('[data-auth-mode="login"]').click()`);
  await until(`getComputedStyle(document.querySelector('#app-login-container')).display !== 'none'`, 'login form');
  await evaluate(`document.querySelector('#app-login-email').value=${JSON.stringify(member.user.email)};document.querySelector('#app-login-password').value=${JSON.stringify(PASSWORD)};document.querySelector('#app-login-form').requestSubmit()`);
  await until(welcome, 'returning-login invitation welcome');
  assert.equal((await request(installManifest)).start_url, '/');
  pass('returning login goes straight to welcome and invalidates browser install handoff');

  await reset();
  await navigate(invitePath);
  await until(`!!document.querySelector('[data-auth-mode="signup"]')`, 'signup button');
  await evaluate(`document.querySelector('[data-auth-mode="signup"]').click()`);
  await until(`getComputedStyle(document.querySelector('#app-signup-form')).display !== 'none'`, 'signup form');
  await evaluate(`document.querySelector('#app-signup-email').value='new-${run}@example.test';document.querySelector('#app-signup-password').value=${JSON.stringify(PASSWORD)};document.querySelector('#app-signup-confirm').value=${JSON.stringify(PASSWORD)};document.querySelector('#app-signup-policy').checked=true;document.querySelector('#app-signup-form').requestSubmit()`);
  await until(`document.querySelector('#app-onboarding-container').dataset.step === 'gyms' && !!document.querySelector('.app-onb-skip-inline')`, 'new signup gym setup');
  await cdp('Page.reload', { ignoreCache: true });
  await until(`document.querySelector('#app-onboarding-container').dataset.step === 'gyms' && getComputedStyle(document.querySelector('#app-onboarding-container')).display !== 'none'`, 'new signup resumes setup on reload');
  await evaluate(`document.querySelector('.app-onb-skip-inline').click()`);
  await until(`!!document.querySelector('#app-onb-first-name')`, 'name capture');
  await evaluate(`document.querySelector('#app-onb-first-name').value='New';document.querySelector('#app-onb-last-name').value='Member';document.querySelector('.app-onb-name-save').click()`);
  await until(`!!document.querySelector('.app-onb-finish')`, 'optional setup');
  await shot('team-new-signup-setup');
  await evaluate(`document.querySelector('.app-onb-finish').click()`);
  await until(welcome, 'new signup invitation welcome');
  await shot('team-new-signup-welcome');
  pass('new signup completes resumable onboarding before invitation welcome');
  const newToken = await evaluate(`localStorage.getItem('appLocalToken')`);
  assert.equal((await request(`/api/teams/invite/${invite}`, { token: newToken })).myRequestStatus, 'none');
  assert.equal((await request(`/api/teams/invite/${invite}`, { token: member.token })).myRequestStatus, 'none');
  pass('opening welcome and completing onboarding never requests membership');

  const { continuation, manifestUrl } = await request(`/api/teams/invite/${invite}/continuation`, { method: 'POST' });
  const manifest = await request(manifestUrl);
  assert.equal(manifest.id, '/'); assert.equal(manifest.scope, '/');
  assert.ok(!manifest.start_url.includes(invite));
  await reset();
  await navigate(manifest.start_url);
  await until(`location.pathname === ${JSON.stringify(invitePath)} && !!document.querySelector('.app-onb-team-preview')?.textContent.includes('Join Journey Fixture')`, 'fresh-storage continuation');
  assert.equal(await evaluate(`location.search`), '');
  await shot('team-fresh-storage-continuation');
  await reset();
  await navigate('/?teamContinuation=' + continuation);
  await until(`location.search === '' && !!document.querySelector('[data-auth-mode]')`, 'used continuation ignored');
  assert.equal(await evaluate(`localStorage.getItem('appPendingTeamInvite')`), null);
  assert.equal((await request(manifestUrl)).start_url, '/');
  pass('fresh storage restores Team once; replay silently opens ordinary app');
  // A returning member's confirmed account name must not be requested again.
  const named = await signup('named');
  await request('/api/my-gyms/link', { token: named.token, body: { gymId: 'psycle-london', email: 'dev@psycle.com', password: 'fixture', rememberLogin: false } });
  await request('/api/settings', { token: named.token, method: 'PUT', body: { firstName: 'Known', lastName: 'Member' } });
  await reset();
  await navigate('/');
  await until(`!!document.querySelector('[data-auth-mode="login"]')`, 'normal login intro');
  await evaluate(`document.querySelector('[data-auth-mode="login"]').click()`);
  await until(`getComputedStyle(document.querySelector('#app-login-container')).display !== 'none'`, 'named account login');
  await evaluate(`document.querySelector('#app-login-email').value=${JSON.stringify(named.user.email)};document.querySelector('#app-login-password').value=${JSON.stringify(PASSWORD)};document.querySelector('#app-login-form').requestSubmit()`);
  await until(`document.querySelector('#app-onboarding-container').dataset.step === 'features'`, 'confirmed name skipped');
  assert.equal(await evaluate(`!!document.querySelector('#app-onb-first-name')`), false);
  await shot('existing-account-name-skipped');
  pass('returning account with saved first and last name skips name capture');
  fs.writeFileSync(path.join(out, 'team-join-results.json'), JSON.stringify({ browser: 'User Google Chrome CDP9222', results, physicalInstallTested: false }, null, 2) + '\n');
  console.log(`${results.length}/${results.length} Team join browser checks passed`);
  await cdp('Emulation.setEmulatedMedia', { features: [] });
  ws.close();
})().catch(e => { console.error(e); ws.close(); process.exitCode = 1; });
