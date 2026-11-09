// Regression tests for rejected post-renewal sessions in actual background workers.
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const providers = require('./providers');
let requestImpl, listImpl, bookImpl, swapImpl, renewals, requests, lists, books, swaps, serial = 0;
const adapter = {
  isMockUser: () => false,
  releaseAtFor: () => null,
  request: (_path, options) => { requests++; return requestImpl(options.token); },
  listBookings: session => { lists++; return listImpl(session); },
  listWaitlists: async () => [],
  refreshSession: async () => { renewals++; return { accessToken: `renewed-${serial}` }; },
  login: async () => ({ session: { accessToken: `manual-${++serial}` }, profile: { raw: {} } }),
  fetchEventDetails: async () => ({ event: {}, slots: [{ id: 'only', isAvailable: true }], objects: [] }),
  bookSlot: (_event, _slots, session) => { books++; return bookImpl(session); },
  swapSpots: (_booking, _current, _target, session) => { swaps++; return swapImpl(session); },
};
providers.getProvider = () => adapter;
const db = require('./db');
const auth = require('./auth');
const poller = require('./poller');
const sync = require('./booking-sync');
const scheduler = require('./scheduler');
const GYM = 'jab-boxing';
const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const unauthorized = () => Object.assign(new Error('provider rejected session'), { status: 401 });
const defer = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return { promise, resolve }; };
function user() {
  requests=lists=books=swaps=renewals=0;
  const uid=db.createAccount(`retry-${++serial}@local.test`,'safe-test-password');
  db.upsertUserGym(uid,GYM,{session_json:JSON.stringify({accessToken:`old-${serial}`}),status:'active'});
  return uid;
}
const incidentCount = uid => db.db.prepare('SELECT COUNT(*) n FROM gym_login_notifications WHERE user_id=?').get(uid).n;

check('poller records one incident when the renewed session is rejected and stops further renewal',async()=>{
  const uid=user();requestImpl=async()=>({status:401,ok:false});
  for(let i=0;i<2;i++)await assert.rejects(poller.fetchFromGym(uid,GYM,'/test'),e=>e.code==='GYM_SESSION_EXPIRED');
  assert.equal(requests,2);assert.equal(renewals,1);assert.equal(incidentCount(uid),1);assert.equal(db.isUserGymAvailable(uid,GYM),false);
});
check('booking sync records one incident for a rejected retried session and stops further renewal',async()=>{
  const uid=user();listImpl=async()=>{throw unauthorized();};
  for(let i=0;i<2;i++)await assert.rejects(sync.bookingRowsFor(uid,GYM),e=>e.code==='GYM_SESSION_EXPIRED');
  assert.equal(lists,2);assert.equal(renewals,1);assert.equal(incidentCount(uid),1);assert.equal(db.isUserGymAvailable(uid,GYM),false);
});
check('scheduler pauses the real queue and creates one incident when its current renewed session is rejected',async()=>{
  const uid=user();bookImpl=async()=>({ok:false,status:401});
  const preferences={preferredSlots:[],preferredRows:[],requiredCount:1,bookAny:true};
  const id=db.addAutoBooking(uid,`current-retry-${serial}`,'Boxing','Coach','Studio','',new Date(Date.now()+3*864e5).toISOString(),preferences,null,'BOXING',null,GYM);
  const row=db.getUserAutoBookings(uid,GYM).find(r=>r.id===id);
  await scheduler.executeAutoBookForClass(row);await scheduler.executeAutoBookForClass(row);
  assert.equal(books,2);assert.equal(renewals,1);assert.equal(incidentCount(uid),1);assert.equal(db.isUserGymAvailable(uid,GYM),false);assert.equal(db.getUserAutoBookings(uid,GYM)[0].status,'pending');
});
for(const status of [429,503]){
  check(`poller preserves renewed session on post-renewal ${status}`,async()=>{
    const uid=user();requestImpl=async()=>({status:requests===1?401:status,ok:false});
    assert.equal((await poller.fetchFromGym(uid,GYM,'/test')).status,status);assert.equal(db.getUserGym(uid,GYM).status,'active');assert.equal(incidentCount(uid),0);
    scheduler._resetRateLimitBackoffForTests();
  });
  check(`booking sync preserves renewed session on post-renewal ${status}`,async()=>{
    const uid=user();listImpl=async()=>{throw lists===1?unauthorized():Object.assign(new Error('temporary'),{status});};
    await assert.rejects(sync.bookingRowsFor(uid,GYM),e=>e.status===status);assert.equal(db.getUserGym(uid,GYM).status,'active');assert.equal(incidentCount(uid),0);
  });
}
for(const kind of ['poller','sync','scheduler'])for(const replacement of ['manual-login','session-only-write']){
  check(`${kind}: late retried 401 cannot invalidate a newer ${replacement}`,async()=>{
    const uid=user(), started=defer(), finish=defer();let operation;
    if(kind==='poller'){
      requestImpl=async()=>{if(requests===1)return {status:401,ok:false};started.resolve();await finish.promise;return {status:401,ok:false};};
      operation=poller.fetchFromGym(uid,GYM,'/test').catch(e=>e);
    }else if(kind==='sync'){
      listImpl=async()=>{if(lists===1)throw unauthorized();started.resolve();await finish.promise;throw unauthorized();};
      operation=sync.bookingRowsFor(uid,GYM).catch(e=>e);
    }else{
      bookImpl=async()=>{if(books===1)return {ok:false,status:401};started.resolve();await finish.promise;return {ok:false,status:401};};
      const preferences={preferredSlots:[],preferredRows:[],requiredCount:1,bookAny:true};
      const id=db.addAutoBooking(uid,`retry-event-${serial}`,'Boxing','Coach','Studio','',new Date(Date.now()+3*864e5).toISOString(),preferences,null,'BOXING',null,GYM);
      const row=db.getUserAutoBookings(uid,GYM).find(r=>r.id===id);
      operation=scheduler.executeAutoBookForClass(row);
    }
    await Promise.race([started.promise, operation.then(() => { throw new Error('Worker finished before retry started'); })]);
    if(replacement==='manual-login')await auth.linkGymAccount(uid,GYM,'gym@local.test','password',false);
    else db.setGymSession(uid,GYM,{accessToken:'newer-session-with-same-revision'});
    const fresh=db.getUserSession(uid,GYM).accessToken,revision=db.getUserGym(uid,GYM).connection_revision;
    finish.resolve();await operation;
    assert.equal(db.getUserGym(uid,GYM).status,'active');assert.equal(db.getUserSession(uid,GYM).accessToken,fresh);assert.equal(db.getUserGym(uid,GYM).connection_revision,revision);assert.equal(incidentCount(uid),0);
    if(kind==='scheduler')assert.equal(db.getUserAutoBookings(uid,GYM)[0].status,'pending','stale rejection preserves queue');
  });
}
// Call the exact helpers used by Auto-Upgrade, with real renewal/DB transitions.
for(const kind of ['upgrade-book','upgrade-swap']) {
  const count=()=>kind==='upgrade-book'?books:swaps;
  const implement=fn=>{if(kind==='upgrade-book')bookImpl=fn;else swapImpl=fn;};
  const invoke=uid=>kind==='upgrade-book'?poller.bookSlotWithRelogin(uid,GYM,'event','target'):poller.swapSpotsWithRelogin(uid,GYM,'booking','current','target');
  for(const thrown of [false,true])check(`${kind}: final ${thrown?'thrown':'returned'} 401 creates one incident and never repeats renewal`,async()=>{
    const uid=user();implement(async()=>{if(thrown&&count()===2)throw unauthorized();return {ok:false,status:401};});
    for(let i=0;i<2;i++)await assert.rejects(invoke(uid),e=>e.code==='GYM_SESSION_EXPIRED');
    assert.equal(count(),2,'only the original attempt and one existing retry');assert.equal(renewals,1);assert.equal(incidentCount(uid),1);assert.equal(db.isUserGymAvailable(uid,GYM),false);
  });
  check(`${kind}: successful mutations run once, including a successful existing retry`,async()=>{
    for(const expired of [false,true]){const uid=user();let writes=0;implement(async()=>{if(expired&&count()===1)return {ok:false,status:401};writes++;return {ok:true,bookingId:'confirmed'};});
      assert.equal((await invoke(uid)).ok,true);assert.equal(count(),expired?2:1);assert.equal(writes,1,'no duplicate successful mutation');assert.equal(renewals,expired?1:0);assert.equal(incidentCount(uid),0);}
  });
  for(const status of [429,503])check(`${kind}: post-renewal ${status} keeps the session and makes no extra attempt`,async()=>{
    const uid=user();implement(async()=>({ok:false,status:count()===1?401:status}));
    assert.equal((await invoke(uid)).status,status);assert.equal(count(),2);assert.equal(renewals,1);assert.equal(db.getUserGym(uid,GYM).status,'active');assert.equal(incidentCount(uid),0);
  });
  check(`${kind}: thrown post-renewal outage remains transient`,async()=>{
    const uid=user();implement(async()=>{if(count()===1)return {ok:false,status:401};throw Object.assign(new Error('outage'),{status:503});});
    await assert.rejects(invoke(uid),e=>e.status===503);assert.equal(count(),2);assert.equal(incidentCount(uid),0);assert.equal(db.getUserGym(uid,GYM).status,'active');
  });
  for(const replacement of ['manual-login','session-only-write'])check(`${kind}: stale rejection preserves newer ${replacement}`,async()=>{
    const uid=user(),started=defer(),finish=defer();implement(async()=>{if(count()===1)return {ok:false,status:401};started.resolve();await finish.promise;return {ok:false,status:401};});
    const operation=invoke(uid).catch(e=>e);await Promise.race([started.promise,operation.then(()=>{throw new Error('Mutation finished before retry started');})]);
    if(replacement==='manual-login')await auth.linkGymAccount(uid,GYM,'gym@local.test','password',false);else db.setGymSession(uid,GYM,{accessToken:'newer-unversioned-token'});
    const fresh=db.getUserSession(uid,GYM).accessToken,revision=db.getUserGym(uid,GYM).connection_revision;
    finish.resolve();await operation;assert.equal(count(),2);assert.equal(renewals,1);assert.equal(db.getUserGym(uid,GYM).status,'active');assert.equal(db.getUserSession(uid,GYM).accessToken,fresh);assert.equal(db.getUserGym(uid,GYM).connection_revision,revision);assert.equal(incidentCount(uid),0);
  });
}
(async()=>{let failed=0;for(const {name,fn}of checks){try{await fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.stack);}}console.log(`${checks.length-failed}/${checks.length} gym-retry-state checks passed`);process.exit(failed?1:0);})();
