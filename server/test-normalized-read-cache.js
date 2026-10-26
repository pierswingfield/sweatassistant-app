// Shared native API/MCP caching: isolated provider fixtures, never live traffic.
process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY ||= 'b'.repeat(64);
process.env.JWT_SECRET = 'offline-read-cache-signing-key';
process.env.JAB_BOXING_ENABLED = 'true';
const assert = require('node:assert/strict');
const db = require('./db');
const reads = require('./normalized-reads');
const cache = require('./private-read-cache');
const { getProvider } = require('./providers');
const { timedProviderFetch } = require('./logger');
const tick = () => new Promise(r => setImmediate(r));
(async () => {
  const [gymId, otherGym] = db.getGyms().filter(g => g.enabled).map(g => g.id);
  const uid = db.createAccount('read-cache@example.test', 'fixture-password');
  const other = db.createAccount('other-cache@example.test', 'fixture-password');
  for (const user of [uid, other]) for (const gym of [gymId, otherGym]) {
    db.linkGym(user, gym); db.updateUserJWT(user, 'fixture-session', new Date(Date.now() + 3600000).toISOString(), gym);
  }
  const read = (name, ...args) => db.runWithGymContext(uid, gymId, () => reads[name](uid, ...args));
  const p = getProvider(gymId), p2 = getProvider(otherGym);
  const originals = new Map();
  const stub = (obj, key, value) => { originals.set([obj,key], obj[key]); obj[key] = value; };
  const calls = { details:0, bookings:0, credits:0, timetable:0, otherGym:0 };
  stub(p, 'fetchEventDetails', async () => { calls.details++; return { event:{ id:'1', releaseAt:'2090-01-01T00:00:00Z' }, slots:[] }; });
  stub(p, 'listBookings', async () => { calls.bookings++; return []; });
  stub(p, 'getCredits', async () => { calls.credits++; return []; });
  stub(p, 'fetchTimetable', async () => { calls.timetable++; return []; });
  stub(p, 'hasFreshnessStamps', () => false);
  stub(p2, 'listBookings', async () => { calls.otherGym++; return []; });
  let server;
  try {
    await read('eventDetails','1'); await read('eventDetails','1');
    await read('bookings'); await read('bookings'); await read('credits'); await read('credits');
    assert.deepEqual([calls.details,calls.bookings,calls.credits],[1,1,1], 'fresh shared service reads reuse normalized responses');
    const changed = await read('bookings'); changed.bookings.push({ id:'consumer-only' });
    assert.deepEqual((await read('bookings')).bookings, [], 'caller cannot mutate cached response');
    await db.runWithGymContext(other,gymId,()=>reads.bookings(other));
    assert.equal(calls.bookings,2,'same gym/token still isolates accounts');
    await db.runWithGymContext(uid,otherGym,()=>reads.bookings(uid));
    assert.equal(calls.otherGym,1,'same provider IDs isolate gyms');
    await read('timetable'); await read('timetable'); assert.equal(calls.timetable,1,'timetable keeps shared fresh-cache behavior');

    const express = require('express'); const app = express(); app.use(express.json()); app.use('/api', require('./routes-normalized'));
    server = app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
    const token = require('jsonwebtoken').sign({userId:uid},process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/bookings`,{headers:{authorization:`Bearer ${token}`,'x-gym-id':gymId}});
    assert.equal(response.status,200); await response.json();
    assert.equal(calls.bookings,2,'actual native API route uses same completed cache');
    const store = require('./mcp/store'), context = require('./mcp/context');
    store.registerClient('cache-fixture','Cache fixture');
    const grantId = store.createGrant({userId:uid,issuer:'https://fixture.test/',subject:'cache-user',clientId:'cache-fixture',scopes:['account:read'],gymIds:[gymId],expiresAt:Date.now()+3600000,consentReference:'offline-fixture'});
    const identity={issuer:'https://fixture.test/',subject:'cache-user',clientId:'cache-fixture',grantId,scopes:['account:read'],expiresAt:Date.now()+3600000};
    const mcpRead=()=>context.run({identity,scope:'account:read',gymId,providerReads:true},()=>db.runWithGymContext(uid,gymId,()=>require('./mcp/tools').catalog.get_my_bookings.run(store.authorize(identity),{gymId,limit:1,offset:0})));
    await mcpRead(); assert.equal(calls.bookings,2,'MCP reuses native completed cache, not an internal HTTP call');
    require('./mcp/access').setGym(gymId,false);
    await assert.rejects(mcpRead,e=>e.code==='ACCESS_DENIED');
    require('./mcp/access').setGym(gymId,true);
    store.revokeGrant(uid,grantId); await assert.rejects(mcpRead,e=>e.code==='ACCESS_DENIED');
    await read('bookings'); assert.equal(calls.bookings,2,'MCP policy does not disable the native app cache');

    await timedProviderFetch(gymId,'POST','/fixture-write',async()=>new Response('{}'));
    await read('bookings'); await read('timetable');
    assert.equal(calls.bookings,3); assert.equal(calls.timetable,2,'shared transport writes invalidate timetable too');
    let closeBody;
    const write = timedProviderFetch(gymId,'PATCH','/fixture-write',async()=>new Response(new ReadableStream({start(c){closeBody=()=>c.close();}})));
    await tick(); await assert.rejects(()=>read('bookings'),e=>e.code==='READ_CHANGED');
    closeBody(); await write; await read('bookings'); assert.equal(calls.bookings,4);

    cache.invalidateGym(gymId);
    let releaseRead; p.listBookings=()=>new Promise(r=>{releaseRead=r});
    const pending=read('bookings'); await tick();
    await timedProviderFetch(gymId,'DELETE','/fixture-write',async()=>new Response('{}'));
    releaseRead([]); await assert.rejects(()=>pending,e=>e.code==='READ_CHANGED');
    p.listBookings=async()=>{calls.bookings++;return[]};
    db.updateUserJWT(uid,'changed-session',new Date(Date.now()+3600000).toISOString(),gymId);
    await read('bookings'); assert.equal(calls.bookings,5,'session rotation cannot reuse an old authenticated entry');
    db.setAccountPassword(uid,'different-fixture-password');
    await read('bookings'); assert.equal(calls.bookings,6,'account authentication changes invalidate cache identity');
    cache.invalidateGym(gymId);
    p.listBookings=()=>new Promise(r=>{releaseRead=r});
    const detached=read('bookings'); await tick(); db.unlinkGym(uid,gymId); releaseRead([]);
    await assert.rejects(()=>detached); await assert.rejects(()=>read('bookings'));
    db.linkGym(uid,gymId); db.updateUserJWT(uid,'changed-session',new Date(Date.now()+3600000).toISOString(),gymId);
    p.listBookings=async()=>{calls.bookings++;return[]};
    await read('bookings'); assert.equal(calls.bookings,7,'relink cannot revive earlier link data');
    db.upsertUserGym(uid,gymId,{status:'disabled'});
    await assert.rejects(()=>read('bookings'),e=>e.code==='ACCESS_DENIED','disabled link cannot reuse a fresh native cache entry');
    db.upsertUserGym(uid,gymId,{status:'active'});
    const freshGrant = store.createGrant({userId:uid,issuer:'https://fixture.test/',subject:'cache-user',clientId:'cache-fixture',scopes:['account:read'],gymIds:[gymId],expiresAt:Date.now()+3600000,consentReference:'offline-fixture'});
    const freshIdentity = {...identity,grantId:freshGrant};
    await context.run({identity:freshIdentity,scope:'account:read',gymId,providerReads:true}, async()=>{
      require('./mcp/access').setAccount(uid,false);
      await assert.rejects(()=>read('bookings'),e=>e.code==='ACCESS_DENIED','cache layer itself reauthorizes an active MCP caller');
      require('./mcp/access').setAccount(uid,true);
    });
    cache.invalidateGym(gymId);
    p.listBookings=()=>new Promise(r=>{releaseRead=r});
    const revokedRead=context.run({identity:freshIdentity,scope:'account:read',gymId,providerReads:true},()=>read('bookings'));
    await tick(); store.revokeGrant(uid,freshGrant); releaseRead([]);
    await assert.rejects(()=>revokedRead,e=>e.code==='ACCESS_DENIED','revoked in-flight data cannot populate cache');

    let now=0,n=0; const bounded=cache.createCache({now:()=>now,maxEntries:2,maxBytes:100,maxEntryBytes:50,maxFlights:2});
    const get=(key,fn=async()=>({n:++n}))=>bounded.read('fixture-gym',key,10,()=>true,fn);
    await get('a'); await get('a'); assert.equal(n,1); now=11; await get('a'); assert.equal(n,2,'expired response refetches, never serves stale');
    await get('b'); await get('c'); assert.equal(bounded.stats().entries,2); await get('a'); assert.equal(n,5,'LRU capacity evicts');
    await get('large',async()=>({text:'x'.repeat(100)})); assert.ok(bounded.stats().bytes<=100);
    let release; const flight=get('pending',()=>new Promise(r=>{release=r})); const joined=get('pending'); release({n:100});
    assert.deepEqual(await flight,await joined,'same-lane calls single-flight');
    await assert.rejects(()=>get('failed',async()=>{throw Error('fixture');})); await get('failed');
    let finishOne,finishTwo;
    const one=get('capacity-one',()=>new Promise(r=>{finishOne=r}));
    const two=get('capacity-two',()=>new Promise(r=>{finishTwo=r}));
    await assert.rejects(()=>get('over-capacity'),e=>e.code==='READ_CAPACITY');
    finishOne({});finishTwo({});await Promise.all([one,two]);
    const admission=require('./provider-admission'); let finishInteractive,finishBackground;
    const interactive=admission.run({lane:'interactive',userId:uid},()=>get('lane-flight',()=>new Promise(r=>{finishInteractive=r})));
    const background=admission.run({lane:'background',userId:uid},()=>get('lane-flight',()=>new Promise(r=>{finishBackground=r})));
    assert.equal(bounded.stats().inFlight,2,'different lanes must not inherit another callers cancellation/deadline');
    finishInteractive({});finishBackground({});await Promise.all([interactive,background]);
    bounded.invalidateGym('fixture-gym');assert.equal(bounded.stats().bytes,0,'separate lane fills must not double-count a replaced entry');
    const scheduled=require('./schedule-cache').createCache(); let releaseSchedule;
    const old=scheduled.getOrFetch('timetable|fixture|',()=>new Promise(r=>{releaseSchedule=r}));
    scheduled.invalidate('timetable|fixture|');
    assert.deepEqual(await scheduled.getOrFetch('timetable|fixture|',async()=>['new']),['new']);
    releaseSchedule(['old']); await old;
    assert.deepEqual(await scheduled.getOrFetch('timetable|fixture|',async()=>['wrong']),['new'],'invalidation prevents stale refill or joining pre-write flight');
    console.log('Normalized cache native/MCP isolation, mutation, freshness and capacity fixtures passed');
  } finally {
    for(const [[obj,key],value]of originals){if(value===undefined)delete obj[key];else obj[key]=value;}
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  }
})().catch(e=>{console.error(e.message);process.exitCode=1});
