// Exercise the real adapter -> booking sync -> renewal -> incident chain, at HTTP.
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const db = require('./db');
const sync = require('./booking-sync');
const connection = require('./gym-connection');
const { getProvider } = require('./providers');
const gym = 'jab-boxing';
const nativeFetch = global.fetch;
let serial = 0, calls = [];
const checks = [];
const check = (name, fn) => checks.push({name, fn});
function account() {
  const uid = db.createAccount(`mt-session-${++serial}@local.test`, 'local-test-password');
  db.upsertUserGym(uid, gym, {status:'active'});
  db.setGymSession(uid, gym, {accessToken:'expired-access', refreshToken:'existing-refresh'});
  return uid;
}
function upstream({reservationStatus=401, refreshStatus=400, freshStatus=200}={}) {
  calls=[];
  global.fetch=async(url, opts={})=>{
    const path=new URL(url).pathname;
    calls.push({path,method:opts.method||'GET'});
    if(path.endsWith('/token/'))return new Response(JSON.stringify(refreshStatus===200?{access_token:'fresh-access',refresh_token:'fresh-refresh',expires_in:3600}:{error:'invalid_grant'}),{status:refreshStatus});
    assert.ok(path.endsWith('/me/reservations'),'only reservations or token refresh permitted');
    const status=opts.headers.authorization==='Bearer fresh-access'?freshStatus:reservationStatus;
    return new Response(JSON.stringify(status===200?{results:[]}:{detail:'Unauthorized'}),{status});
  };
}
const count = uid => db.db.prepare('SELECT count(*) n FROM gym_login_notifications WHERE user_id=?').get(uid).n;
check('real reservation 401 and rejected refresh create exactly one incident and stop later reads',async()=>{
  const uid=account();upstream();
  await assert.rejects(sync.bookingRowsFor(uid,gym),e=>e.code==='GYM_SESSION_EXPIRED');
  await connection.deliverPending();
  assert.equal(db.getUserGym(uid,gym).status,'needs_relogin');assert.equal(count(uid),1);
  const n=calls.length;await assert.rejects(sync.bookingRowsFor(uid,gym),e=>e.code==='GYM_SESSION_EXPIRED'||e.code==='GYM_UNAVAILABLE');
  assert.equal(calls.length,n);assert.equal(count(uid),1);
});
check('real reservation 401 with a valid refresh recovers without an incident',async()=>{
  const uid=account();upstream({refreshStatus:200});
  assert.deepEqual(await sync.bookingRowsFor(uid,gym),[]);
  assert.equal(db.getUserGym(uid,gym).status,'active');assert.equal(count(uid),0);
  assert.equal(db.getUserSession(uid,gym).accessToken,'fresh-access');
  assert.equal(calls.filter(c=>c.path.endsWith('/token/')).length,1);
});
check('real reservation retry 401 creates one incident after successful renewal',async()=>{
  const uid=account();upstream({refreshStatus:200,freshStatus:401});
  await assert.rejects(sync.bookingRowsFor(uid,gym),e=>e.code==='GYM_SESSION_EXPIRED');
  assert.equal(count(uid),1);assert.equal(db.getUserGym(uid,gym).status,'needs_relogin');
});
check('full sync rereads after its own successful renewal and records fresh bookings and waitlists',async()=>{
  const uid=account();upstream({refreshStatus:200});
  const result=await sync.syncUserGym(uid,gym,{force:true});
  assert.equal(result.ok,true,result.error);assert.deepEqual(result.bookings,[]);assert.deepEqual(result.waitlists,[]);
  assert.equal(db.getBookingSyncState(uid,gym).last_error,null);assert.ok(db.getBookingSyncState(uid,gym).last_synced_at);
  assert.equal(count(uid),0);assert.equal(calls.filter(c=>c.path.endsWith('/token/')).length,1);
  assert.equal(calls.filter(c=>c.path.endsWith('/me/reservations')).length,4,'one bounded reread of the fresh snapshot');
});
check('full sync restart is bounded when the connection keeps changing and cannot write a stale snapshot',async()=>{
  const uid=account();let reads=0;
  db.replaceBookingCache(uid,[{bookingId:'keep',gymId:gym,eventId:'keep',startAt:'2099-01-01T12:00:00Z'}],[gym]);
  global.fetch=async()=>{reads++;db.db.prepare('UPDATE user_gyms SET connection_revision=connection_revision+1 WHERE user_id=? AND gym_id=?').run(uid,gym);return new Response(JSON.stringify({results:[]}),{status:200})};
  const result=await sync.syncUserGym(uid,gym,{force:true});
  assert.equal(result.ok,false);assert.equal(reads,2,'at most one fresh-snapshot restart');
  assert.equal(db.db.prepare('SELECT booking_id FROM booking_cache WHERE user_id=? AND gym_id=?').get(uid,gym).booking_id,'keep');
  assert.equal(count(uid),0);assert.equal(db.getUserGym(uid,gym).status,'active');
});
for(const status of [429,503])check(`real reservation ${status} stays transient and keeps session`,async()=>{
  const uid=account();upstream({reservationStatus:status});
  await assert.rejects(sync.bookingRowsFor(uid,gym),e=>e.status===status);
  assert.equal(count(uid),0);assert.equal(db.getUserGym(uid,gym).status,'active');
  assert.equal(db.getUserSession(uid,gym).accessToken,'expired-access');
  assert.equal(calls.filter(c=>c.path.endsWith('/token/')).length,0);
});
(async()=>{let passed=0;for(const t of checks){try{await t.fn();passed++;console.log('PASS '+t.name)}catch(e){console.error('FAIL '+t.name+': '+e.message)}}global.fetch=nativeFetch;console.log(`${passed}/${checks.length} MarianaTek session rejection checks passed`);process.exit(passed===checks.length?0:1)})().catch(e=>{global.fetch=nativeFetch;console.error(e.message);process.exit(1)});
