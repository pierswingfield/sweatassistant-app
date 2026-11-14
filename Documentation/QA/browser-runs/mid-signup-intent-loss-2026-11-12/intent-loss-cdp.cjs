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
  await evaluate(`localStorage.clear(); sessionStorage.clear(); ${session ? `localStorage.setItem('appLocalToken',${JSON.stringify(session.token)});localStorage.setItem('appUserId',${JSON.stringify(String(session.user.id))});` : ''}`);
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

const Database = require('../../../../server/node_modules/better-sqlite3');
async function rootLogin(email) {
  await reset(); await navigate('/');
  await until(`!!document.querySelector('[data-auth-mode="login"]')`, 'ordinary fresh-storage intro');
  await login(email);
}
async function finishSetup() { await toFeatures(); await evaluate(`document.querySelector('.app-onb-finish').click()`); }
async function ordinaryFinish() {
  await until(atStep('gyms'), 'ordinary gym setup'); await finishSetup();
  await until(`getComputedStyle(document.querySelector('#app-onboarding-container')).display === 'none'`, 'setup complete');
  await new Promise(r=>setTimeout(r,600)); assert.equal(await evaluate(welcome),false);
}
async function newTeam(label) {
 const captain=await signup(label+'-captain');
 const created=await request('/api/teams',{token:captain.token,body:{name:label+' Fixture',emoji:'🌟'}});
 return {captain,...created};
}
async function newPending(inviteToken,label) {
 await source(inviteToken); const email=`${label}-${run}@example.test`; await signupUI(email); return email;
}
(async () => {
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 await navigate('/'); await until(`!!document.querySelector('#app-onboarding-container')`,'app loaded');
 const a=await newTeam('Lost Intent'); const email=await newPending(a.inviteToken,'same');
 await rootLogin(email); await until(atStep('gyms'),'recovered gym setup'); await finishSetup();
 await until(welcome,'recovered Team welcome'); await shot('after-recovered-welcome');
 const token=await evaluate(`localStorage.getItem('appLocalToken')`);
 assert.equal((await request(`/api/teams/invite/${a.inviteToken}`,{token})).myRequestStatus,'none');
 const completed=await request('/api/teams/onboarding',{token}); assert.equal(completed.step,null); assert.ok(!completed.inviteToken);
 pass('same account recovers lost intent and sees welcome without joining');
 await navigate('/'); await new Promise(r=>setTimeout(r,1000)); assert.equal(await evaluate(welcome),false); pass('ordinary relaunch after welcome does not replay invite');

 const pendingA=await newTeam('Pending A'); const explicitEmail=await newPending(pendingA.inviteToken,'explicit');
 const explicitB=await newTeam('Explicit B'); await source(explicitB.inviteToken); await login(explicitEmail);
 await until(welcome,'explicit Team welcome');
 assert.ok(await evaluate(`document.querySelector('.tm-invite-card').textContent.includes('Explicit B Fixture')`));
 pass('explicit Team B invite takes precedence over pending Team A');
 await navigate('/'); await new Promise(r=>setTimeout(r,1200));
 const explicitAfter = await evaluate(`({path:location.pathname,step:document.querySelector('#app-onboarding-container').dataset.step,pending:!!localStorage.getItem('appPendingTeamInvite')})`);
 console.log('EXPLICIT_B_RELAUNCH',JSON.stringify(explicitAfter));

 const completeTeam=await newTeam('Complete Marker'); const completeEmail=await newPending(completeTeam.inviteToken,'complete');
 const completeDb=new Database(process.env.FIXTURE_DB); const completeUser=completeDb.prepare('SELECT id FROM users WHERE email = ?').get(completeEmail);completeDb.close();
 await reset(); await navigate('/'); await until(`!!document.querySelector('[data-auth-mode="login"]')`,'complete marker intro');
 await evaluate(`localStorage.setItem('appOnboardingComplete:${completeUser.id}','4')`); await login(completeEmail);
 await until(atStep('gyms'),'pending intent overrides complete marker'); await finishSetup(); await until(welcome,'complete marker welcome');
 pass('existing onboarding-complete marker does not suppress pending Team setup');

 const b=await newTeam('Wrong Account'); await newPending(b.inviteToken,'owner');
 const wrong=await signup('other'); await rootLogin(wrong.user.email); await ordinaryFinish();
 assert.equal(await evaluate(`localStorage.getItem('appPendingTeamInvite')`),null);
 pass('wrong account cannot recover another account intent');

 const d=await newTeam('Disabled'); const disabled=await newPending(d.inviteToken,'disabled');
 await request(`/api/teams/${d.team.id}/invite`,{token:d.captain.token,method:'PUT',body:{enabled:false}});
 await rootLogin(disabled); await ordinaryFinish(); pass('disabled invite is not recovered');

 const r=await newTeam('Rotated'); const rotated=await newPending(r.inviteToken,'rotated');
 await request(`/api/teams/${r.team.id}/invite/rotate`,{token:r.captain.token,method:'POST'});
 await rootLogin(rotated); await ordinaryFinish(); pass('rotated invite is not recovered');

 const x=await newTeam('Expired'); const expired=await newPending(x.inviteToken,'expired');
 assert.ok(process.env.FIXTURE_DB,'Set FIXTURE_DB to disposable local fixture');
 const db=new Database(process.env.FIXTURE_DB); const result=db.prepare('UPDATE team_signup_onboarding SET expires_at = 0 WHERE user_id = (SELECT id FROM users WHERE email = ?)').run(expired);db.close();assert.equal(result.changes,1);
 await rootLogin(expired); await ordinaryFinish(); pass('expired pending signup is not recovered');

 const z=await newTeam('Outage'); const outage=await newPending(z.inviteToken,'outage');
 await reset(); await navigate('/'); await until(`!!document.querySelector('[data-auth-mode="login"]')`,'outage intro');
 await evaluate(`window.__realFetch=window.fetch;window.fetch=(input,opts={})=>String(input).includes('/api/teams/onboarding') && (!opts.method || opts.method==='GET') ? Promise.resolve(new Response('{}',{status:500})) : window.__realFetch(input,opts)`);
 await login(outage); await until(`document.querySelector('#app-login-error')?.textContent.includes('setup')`,'retryable pending lookup error');
 await evaluate(`window.fetch=window.__realFetch;document.querySelector('#app-login-form').requestSubmit()`);
 await until(atStep('gyms'),'outage retry resumes');await finishSetup();await until(welcome,'outage retry welcome');
 pass('transient lookup failure retains intent for retry');
 fs.writeFileSync(path.join(out,'intent-loss-results.json'),JSON.stringify({browser:'User Chrome CDP9222; cleared localStorage and sessionStorage',results,physicalInstallTested:false},null,2)+'\n');
 console.log(`${results.length}/${results.length} loss recovery browser checks passed`);ws.close();
})().catch(e=>{console.error(e);ws.close();process.exitCode=1});
