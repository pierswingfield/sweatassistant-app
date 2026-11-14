// Local-only regression loop. Attaches to the existing user's Chrome tab; never launches a browser.
// TAB_ID=<one shared QA tab> node <this file>. Server3000 + Vite5173 must be running.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ORIGIN = 'http://localhost:3000';
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


const network = [];
ws.addEventListener('message', ({data}) => {
  const m=JSON.parse(data);
  if (m.method !== 'Network.responseReceived') return;
  const u=new URL(m.params.response.url);
  if (/^\/api\/teams\//.test(u.pathname)) network.push({path:u.pathname.replace(/\/invite\/[^/]+/,'/invite/[redacted]').replace(/\/continuation\/[^/]+/,'/continuation/[redacted]'),status:m.params.response.status});
});
(async () => {
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 await cdp('Network.enable');
 await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await cdp('Emulation.setEmulatedMedia',{features:[{name:'display-mode',value:'standalone'},{name:'prefers-reduced-motion',value:'no-preference'}]});
 await navigate('/'); await until(`!!document.querySelector('#app-onboarding-container')`,'production app loaded');
 const captain=await signup('finish-captain'); const {inviteToken}=await request('/api/teams',{token:captain.token,body:{name:'Finish Routing Fixture',emoji:'🌟'}});
 const sourceState=await source(inviteToken); const email=`finish-${run}@example.test`;
 await signupUI(email); await reset(); await navigate('/');
 await until(`!!document.querySelector('[data-auth-mode="login"]')`,'fresh storage intro');
 await login(email); await until(atStep('gyms'),'recovered gym setup');
 await toFeatures();
 await evaluate(`(() => { window.__routeTrace=[]; const media=window.matchMedia.bind(window); window.matchMedia=(q)=>q.includes('display-mode: standalone') ? {...media(q), matches:true, media:q, addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}} : media(q); const clean=v=>String(v||'').startsWith('/t/')?'/t/[redacted]':String(v||'').split('?')[0];for(const method of ['pushState','replaceState']){const orig=history[method];history[method]=function(...args){window.__routeTrace.push({method,from:clean(location.pathname),to:clean(args[2]),time:performance.now()});return orig.apply(this,args)}} })()`);
 const before=await evaluate(`({path:location.pathname,hasPending:!!localStorage.getItem('appPendingTeamInvite'),signupMarked:!!localStorage.getItem('appTeamInviteSignup'),standalone:matchMedia('(display-mode: standalone)').matches})`);
 assert.equal(before.hasPending,true,'server recovery must restore pending invite');assert.equal(before.standalone,true);
 network.length=0; await evaluate(`document.querySelector('.app-onb-finish').click()`);
 await until(`document.querySelector('#app-panel-teams')?.offsetParent !== null && !!document.querySelector('.tm-invite-card')?.textContent.includes('Request to join Finish Routing Fixture?')`,'visible invite welcome');
 await new Promise(r=>setTimeout(r,1500));
 const after=await evaluate(`({path:location.pathname,visibleHome:!!document.querySelector('#app-panel-home')?.offsetParent,visibleTeams:!!document.querySelector('#app-panel-teams')?.offsetParent,visibleWelcome:!!document.querySelector('.tm-invite-card')?.offsetParent,text:document.querySelector('.tm-invite-card')?.innerText,trace:window.__routeTrace})`);
 await shot('visible-welcome');console.log('BEFORE',JSON.stringify(before));console.log('AFTER',JSON.stringify(after));console.log('TEAM_RESPONSES',JSON.stringify(network));
 assert.equal(after.visibleTeams,true);assert.equal(after.visibleWelcome,true);assert.equal(after.visibleHome,false);
 assert.ok(after.trace.some(e=>e.to==='/t/[redacted]'),'route must transition through valid invite');
 assert.ok(network.some(e=>e.path==='/api/teams/invite/[redacted]'&&e.status===200),'preview response must succeed');
 fs.writeFileSync(path.join(out,'routing-result.json'),JSON.stringify({before,after,network},null,2)+'\n');
 console.log('PASS production bundle: visible Team welcome after no-storage standalone-mode setup');
 await cdp('Emulation.clearDeviceMetricsOverride'); await cdp('Emulation.setEmulatedMedia',{features:[]});ws.close();
})().catch(e=>{console.error(e);ws.close();process.exitCode=1});
