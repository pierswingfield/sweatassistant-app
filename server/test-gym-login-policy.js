process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const providers = require('./providers');
let loginCalls = 0, refreshCalls = 0;
let loginImpl = async ({ email, password }) => {
  loginCalls++;
  if (password === 'wrong') throw Object.assign(new Error('Rejected'), { code: 'GYM_CREDENTIAL_REJECTED' });
  return { session: { accessToken: 'session-'+loginCalls, refreshToken: 'refresh', email, password, raw: { email, password } }, profile: { firstName: 'Member', raw: { email, password, first_name: 'Member', nested: { username: email } } } };
};
let refreshImpl = async () => ({ accessToken: 'renewed' });
const fake = { login: c => loginImpl(c), refreshSession: (...args) => { refreshCalls++; return refreshImpl(...args); }, listBookings: async () => [], listWaitlists: async () => [] };
providers.getProvider = () => fake;
const db = require('./db');
const auth = require('./auth');
const policy = require('./policies');
const connection = require('./gym-connection');
const { decrypt } = require('./crypto');
const A = 'psycle-london', B = 'jab-boxing';
const checks = [];
const test = (name, fn) => checks.push({ name, fn });
let seq = 0;
const account = () => db.createAccount(`gym-policy-${++seq}@local.test`, 'safe-test-password');
const link = (uid, gym = A, remember = false) => remember ? auth.linkGymAccount(uid, gym, 'separate@gym.test', 'gym-password', true) : auth.linkGymAccount(uid, gym, 'separate@gym.test', 'gym-password');
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('signup rejects missing, unchecked and obsolete policy versions without creating an account', async () => {
  for (const acceptance of [undefined, { ...policy.CURRENT_ACCEPTANCE, accepted: false }, { ...policy.CURRENT_ACCEPTANCE, termsVersion: 'old' }]) {
    await assert.rejects(auth.handleSignup('not-created@local.test', 'safe-test-password', acceptance), /review and agree/);
    assert.equal(db.getUserByEmail('not-created@local.test'), undefined);
  }
});
test('signup records current versions and a server timestamp', async () => {
  const result = await auth.handleSignup('accepted@local.test', 'safe-test-password', policy.CURRENT_ACCEPTANCE);
  const row = db.db.prepare('SELECT terms_version,privacy_version,policy_accepted_at FROM users WHERE id=?').get(result.user.id);
  assert.equal(row.terms_version, policy.TERMS_VERSION); assert.equal(row.privacy_version, policy.PRIVACY_VERSION); assert.ok(Date.parse(row.policy_accepted_at));
});
test('session-only login stores encrypted session material without reusable email/password echoes', async () => {
  const uid = account(); await link(uid);
  const row = db.getUserGym(uid,A);
  assert.equal(row.gym_email,null); assert.equal(row.encrypted_password,null); assert.equal(row.remember_login,0);
  assert.deepEqual(JSON.parse(row.session_json), { accessToken: 'session-'+loginCalls, refreshToken:'refresh' });
  assert.ok(!row.profile_json.includes('separate@gym.test')); assert.ok(!row.profile_json.includes('gym-password'));
  assert.match(db.db.prepare('SELECT session_json FROM user_gyms WHERE user_id=?').get(uid).session_json,/^s2:/);
  assert.equal(db.getUserById(uid).email,`gym-policy-${seq}@local.test`);
});
test('remember requires a real boolean and only saves after provider success', async () => {
  const uid = account(); const before = loginCalls;
  await assert.rejects(auth.linkGymAccount(uid,A,'gym@local.test','gym-password','true'),/boolean/); assert.equal(loginCalls,before);
  await link(uid,A,true); const saved=db.getUserGym(uid,A);
  assert.equal(saved.gym_email,'separate@gym.test'); assert.equal(decrypt(saved.encrypted_password),'gym-password'); assert.equal(saved.remember_login,1); assert.equal(saved.login_disclosure_version,policy.DISCLOSURE_VERSION);
  await assert.rejects(auth.linkGymAccount(uid,A,'replacement@local.test','wrong',false));
  assert.equal(db.getUserGym(uid,A).encrypted_password,saved.encrypted_password); assert.equal(db.getUserGym(uid,A).connection_revision,saved.connection_revision);
});
test('successful unticked re-login removes previously remembered credentials atomically', async () => {
  const uid=account(); await link(uid,A,true); await auth.linkGymAccount(uid,A,'separate@gym.test','gym-password',false); const row=db.getUserGym(uid,A);
  assert.equal(row.gym_email,null);assert.equal(row.encrypted_password,null);assert.equal(row.remember_login,0);assert.ok(JSON.parse(row.session_json).accessToken);
});
test('forget retains working session, link, settings, calendar and other gym', async () => {
  const uid=account();await link(uid,A,true);await link(uid,B,true);
  db.upsertUserGym(uid,A,{calendar_token:'keep-calendar',priority:77});db.setUserSettings(uid,{autoBookPaused:true},A);
  const before=db.getUserGym(uid,A),other=db.getUserGym(uid,B);
  assert.equal(db.forgetGymLogin(uid,A),true);const row=db.getUserGym(uid,A);
  assert.equal(row.session_json,before.session_json);assert.equal(row.calendar_token,'keep-calendar');assert.equal(row.priority,77);assert.equal(row.status,'active');assert.equal(row.gym_email,null);assert.equal(row.encrypted_password,null);assert.equal(row.remember_login,0);
  assert.equal(db.getUserGym(uid,B).encrypted_password,other.encrypted_password);assert.equal(db.forgetGymLogin(uid,'unknown'),false);
});
test('in-flight renewal cannot replace session or restore credentials after forget', async () => {
  const uid=account();await link(uid,A,true);const old=db.getUserSession(uid,A);const gate=defer();refreshImpl=()=>gate.promise;
  const pending=auth.triggerAutoRelogin(uid,A);db.forgetGymLogin(uid,A);gate.resolve({accessToken:'stale-renewal'});
  assert.equal(await pending,old.accessToken);assert.equal(db.getUserSession(uid,A).accessToken,old.accessToken);assert.equal(db.getUserGym(uid,A).gym_email,null);
});
test('late rejected renewal after forget does not expire a working session', async () => {
  const uid=account();await link(uid,A,true);const gate=defer();refreshImpl=()=>gate.promise;
  const pending=auth.triggerAutoRelogin(uid,A);db.forgetGymLogin(uid,A);gate.reject(Object.assign(new Error('rejected'),{code:'GYM_CREDENTIAL_REJECTED'}));await pending;
  assert.equal(db.getUserGym(uid,A).status,'active');assert.equal(db.getUserGym(uid,A).login_incident,null);
});
test('concurrent definitive failures create one incident/push record, preserve the gym and stop retries', async () => {
  const uid=account();await link(uid);await link(uid,B);const before=refreshCalls;
  refreshImpl=async()=>{throw Object.assign(new Error('session expired'),{code:'GYM_AUTH_REQUIRED'});};
  const results=await Promise.allSettled([auth.triggerAutoRelogin(uid,A),auth.triggerAutoRelogin(uid,A)]);
  assert.ok(results.every(r=>r.status==='rejected'&&r.reason.code==='GYM_SESSION_EXPIRED'));assert.equal(refreshCalls,before+1);
  const row=db.getUserGym(uid,A);assert.equal(row.status,'needs_relogin');assert.ok(row.login_incident);assert.ok(row.login_required_at);assert.equal(row.login_required_reason,'session_expired');
  assert.equal(db.db.prepare('SELECT COUNT(*) n FROM gym_login_notifications WHERE user_id=?').get(uid).n,1);assert.equal(db.isUserGymAvailable(uid,A),false);assert.equal(db.isGymLinked(uid,A),true);assert.equal(db.isUserGymAvailable(uid,B),true);
  await assert.rejects(auth.triggerAutoRelogin(uid,A),e=>e.code==='GYM_SESSION_EXPIRED');assert.equal(refreshCalls,before+1);await connection.deliverPending();
});
test('network outage and rate limit preserve the working session and availability',async()=>{
  for(const status of [undefined,429,503]){const uid=account();await link(uid,A,true);const before=db.getUserSession(uid,A);refreshImpl=async()=>{throw Object.assign(new Error('temporary'),{status});};await assert.rejects(auth.triggerAutoRelogin(uid,A));assert.equal(db.getUserGym(uid,A).status,'active');assert.equal(db.getUserGym(uid,A).login_incident,null);assert.equal(db.getUserSession(uid,A).accessToken,before.accessToken);}
});
test('reconnection syncs fresh rows before restoring availability and preserves user pause',async()=>{
  const uid=account();await link(uid,A,true);db.setUserSettings(uid,{autoBookPaused:true});connection.requireLogin(uid,A,'session_expired');await connection.deliverPending();
  await link(uid,A,false);const row=db.getUserGym(uid,A);assert.equal(row.status,'active');assert.equal(row.login_incident,null);assert.equal(row.gym_email,null);assert.ok(db.getBookingSyncState(uid,A).last_synced_at);assert.equal(db.getUserSettings(uid).autoBookPaused,true);
});
test('CodexFit without saved credentials gives a classified session-expiry answer',async()=>{
  const Provider=require('./providers/codexfit');const p=new Provider(require('./gyms.config').getGymConfig(A));
  await assert.rejects(p.refreshSession({accessToken:'expired'},null),e=>e.code==='GYM_AUTH_REQUIRED');
});
test('MarianaTek refresh works without saved login and does not fall through on outages',async()=>{
  const Provider=require('./providers/marianatek');const p=new Provider(require('./gyms.config').getGymConfig(B));const oldFetch=global.fetch;let calls=0;
  try {global.fetch=async(url,opts)=>{calls++;assert.ok(!opts.body.includes('password'));return {ok:true,json:async()=>({access_token:'fresh',refresh_token:'rotated',expires_in:60})};};
    const renewed=await p.refreshSession({accessToken:'old',refreshToken:'refresh'},null);assert.equal(renewed.accessToken,'fresh');assert.equal(renewed.refreshToken,'rotated');
    let logins=0;p.login=async()=>{logins++;return {session:{accessToken:'login'}};};
    for(const status of [429,503]){global.fetch=async()=>({ok:false,status,json:async()=>({})});await assert.rejects(p.refreshSession({refreshToken:'refresh'},{email:'a',password:'b'}),e=>e.status===status);}
    assert.equal(logins,0);global.fetch=async()=>({ok:false,status:400,json:async()=>({error:'invalid_grant'})});await assert.rejects(p.refreshSession({refreshToken:'refresh'},null),e=>e.code==='GYM_AUTH_REQUIRED');assert.equal((await p.refreshSession({refreshToken:'refresh'},{email:'a',password:'b'})).accessToken,'login');assert.equal(logins,1);
  }finally{global.fetch=oldFetch;}
});
(async()=>{let failed=0;for(const {name,fn} of checks){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(`${checks.length-failed}/${checks.length} gym-login-policy checks passed`);process.exit(failed?1:0);})();
