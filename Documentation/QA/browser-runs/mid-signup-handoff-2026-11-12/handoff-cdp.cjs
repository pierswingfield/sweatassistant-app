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
async function navigate(url) { await evaluate(`window.__qaOldDocument = true`); await cdp('Page.navigate', { url: ORIGIN + url }); await until(`!window.__qaOldDocument && document.readyState === 'complete'`, 'new document'); }
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
const atStep = step => `getComputedStyle(document.querySelector('#app-onboarding-container')).display !== 'none' && document.querySelector('#app-onboarding-container').dataset.step === ${JSON.stringify(step)}`;
const results = [];
const pass = name => { results.push(name); console.log('PASS ' + name); };
async function login(email) {
  await until(`!!document.querySelector('[data-auth-mode="login"]')`, 'login button');
  await evaluate(`document.querySelector('[data-auth-mode="login"]').click()`);
  await until(`getComputedStyle(document.querySelector('#app-login-form')).display !== 'none'`, 'login form');
  await evaluate(`document.querySelector('#app-login-email').value=${JSON.stringify(email)};document.querySelector('#app-login-password').value=${JSON.stringify(PASSWORD)};document.querySelector('#app-login-form').requestSubmit()`);
}
async function signupUI(email) {
  await evaluate(`document.querySelector('[data-auth-mode="signup"]').click()`);
  await until(`getComputedStyle(document.querySelector('#app-signup-form')).display !== 'none'`, 'signup form');
  await evaluate(`document.querySelector('#app-signup-email').value=${JSON.stringify(email)};document.querySelector('#app-signup-password').value=${JSON.stringify(PASSWORD)};document.querySelector('#app-signup-confirm').value=${JSON.stringify(PASSWORD)};document.querySelector('#app-signup-policy').checked=true;document.querySelector('#app-signup-form').requestSubmit()`);
  await until(atStep('gyms'), 'new signup gym setup');
}
async function source(inviteToken) {
  await reset(); await navigate('/t/' + inviteToken);
  await until(`!!document.querySelector('.app-onb-team-preview')`, 'invite preview');
  const manifest = await evaluate(`document.querySelector('[rel=manifest]').getAttribute('href')`);
  const { start_url: start } = await request(manifest);
  assert.match(start, /teamContinuation=/);
  return { manifest, start };
}
async function install(start) {
  await reset(); await navigate(start);
  await until(`location.pathname.startsWith('/t/') && !!document.querySelector('.app-onb-team-preview')`, 'fresh storage restored invitation');
}
async function toName() {
  await until(`!!document.querySelector('.app-onb-skip-inline')`, 'skip gyms');
  await evaluate(`document.querySelector('.app-onb-skip-inline').click()`);
  await until(atStep('name'), 'name setup');
}
async function toFeatures() {
  await toName();
  await evaluate(`document.querySelector('#app-onb-first-name').value='Fixture';document.querySelector('#app-onb-last-name').value='Member';document.querySelector('.app-onb-name-save').click()`);
  await until(atStep('features'), 'optional features');
}
(async () => {
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  await navigate('/'); await until(`!!document.querySelector('#app-onboarding-container')`, 'app loaded');
  const captain = await signup('handoff-captain');
  const returning = await signup('handoff-returning');
  const { inviteToken } = await request('/api/teams', { token: captain.token, body: { name: 'Handoff Fixture', emoji: '🌟' } });
  const before = await source(inviteToken);
  await install(before.start);
  await signupUI(`before-${run}@example.test`);
  pass('install before signup preserves Team and begins setup');

  const created = await source(inviteToken);
  const createdEmail = `created-${run}@example.test`;
  await signupUI(createdEmail);
  await install(created.start); await login(createdEmail);
  await until(atStep('gyms'), 'same account resumes gym setup');
  await shot('same-account-gym-setup');
  pass('install after account creation resumes gym setup for the same account');

  const naming = await source(inviteToken);
  const namingEmail = `naming-${run}@example.test`;
  await signupUI(namingEmail); await toName();
  await new Promise(r => setTimeout(r, 500));
  await install(naming.start); await login(namingEmail);
  await until(atStep('name'), 'same account resumes name setup');
  pass('install during setup resumes the saved name step');

  const during = await source(inviteToken);
  const duringEmail = `during-${run}@example.test`;
  await signupUI(duringEmail); await toFeatures();
  await new Promise(r => setTimeout(r, 800));
  await install(during.start); await login(duringEmail);
  await until(atStep('features'), 'same account resumes optional setup');
  await shot('same-account-features');
  const duringToken = await evaluate(`localStorage.getItem('appLocalToken')`);
  assert.equal((await request(`/api/teams/invite/${inviteToken}`, { token: duringToken })).myRequestStatus, 'none');
  pass('transfer and setup never request Team membership');
  pass('install during setup resumes the saved features step');

  const mismatch = await source(inviteToken);
  await signupUI(`original-${run}@example.test`);
  await install(mismatch.start); await login(returning.user.email);
  await until(welcome, 'different existing account reaches invitation');
  await shot('different-account-welcome');
  pass('different existing account does not inherit new-account setup');

  const after = await source(inviteToken);
  await signupUI(`after-${run}@example.test`); await toFeatures();
  await evaluate(`document.querySelector('.app-onb-finish').click()`);
  await until(welcome, 'source reaches welcome');
  assert.equal((await request(after.manifest)).start_url, '/');
  await reset(); await navigate(after.start);
  await until(`location.search === '' && !!document.querySelector('[data-auth-mode]')`, 'spent continuation opens normal intro');
  assert.equal(await evaluate(`localStorage.getItem('appPendingTeamInvite')`), null);
  pass('after welcome the old continuation opens the ordinary app');

  const replay = await source(inviteToken);
  await install(replay.start);
  await reset(); await navigate(replay.start);
  await until(`location.search === '' && !!document.querySelector('[data-auth-mode]')`, 'replayed continuation opens normal intro');
  assert.equal(await evaluate(`localStorage.getItem('appPendingTeamInvite')`), null);
  pass('reused continuation does not restore an invite');

  const expired = await source(inviteToken);
  const continuation = new URL('http://localhost' + expired.start).searchParams.get('teamContinuation');
  assert.ok(process.env.FIXTURE_DB, 'FIXTURE_DB must point to the disposable local fixture DB');
  const Database = require('../../../../server/node_modules/better-sqlite3'); const crypto = require('node:crypto');
  const db = new Database(process.env.FIXTURE_DB);
  const hash = crypto.createHash('sha256').update(continuation).digest('hex');
  assert.equal(db.prepare('UPDATE team_install_continuations SET expires_at = 0 WHERE continuation_hash = ?').run(hash).changes, 1);
  db.close();
  await reset(); await navigate(expired.start);
  await until(`location.search === '' && !!document.querySelector('[data-auth-mode]')`, 'expired continuation opens normal intro');
  assert.equal(await evaluate(`localStorage.getItem('appPendingTeamInvite')`), null);
  pass('expired continuation does not restore an invite');
  fs.writeFileSync(path.join(out, 'handoff-results.json'), JSON.stringify({ browser: 'User Chrome CDP9222, separate origin-storage simulation', results, physicalInstallTested: false }, null, 2) + '\n');
  console.log(`${results.length}/${results.length} handoff browser checks passed`);
  ws.close();
})().catch(e => { console.error(e); ws.close(); process.exitCode = 1; });
