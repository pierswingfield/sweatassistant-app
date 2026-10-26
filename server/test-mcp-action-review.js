// Review regressions: isolated durable DB, shared services stubbed, all fetch denied.
global.fetch = async () => { throw Error('Unexpected network'); };
const fs=require('node:fs'), path=require('node:path');
const temp=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'action-review-'));
process.env.DB_PATH=path.join(temp,'fixture.db'); process.env.ENCRYPTION_KEY = 'b'.repeat(64);
const assert = require('node:assert/strict');
const db = require('./db'), access = require('./mcp/access'), store = require('./mcp/store');
const actions = require('./mcp/actions'), context = require('./mcp/context'), mutations = require('./normalized-mutations');
const userId = db.createAccount('review@example.test', 'isolated-password');
const gymId = db.getGyms().find(g => g.enabled).id;
db.linkGym(userId, gymId); db.runWithGymContext(userId, gymId, () => db.updateUserJWT(userId, 'fixture-session', new Date(Date.now()+600000).toISOString()));
access.setWritePreference(userId, true);
const config = { writesEnabled:true, providerReads:true, resource:'https://fixture.example/mcp' };
function identity(clientId) {
  store.registerClient(clientId, clientId);
  const value={issuer:'https://fixture.example/',subject:`account:${userId}`,clientId,scopes:['bookings:write','schedule:read','account:read'],expiresAt:Date.now()+600000};
  value.grantId=store.createGrant({userId,...value,gymIds:[gymId],consentReference:'fixture'}); return value;
}
const originalSync=db.db.pragma('synchronous',{simple:true});
const prepareStatement=db.db.prepare.bind(db.db);let durableCommits=0;
db.db.prepare=sql=>{const statement=prepareStatement(sql);if(!sql.includes('INSERT OR IGNORE INTO mcp_action_submissions'))return statement;return {run(...args){assert.ok(db.db.pragma('synchronous',{simple:true})>=2,'submission commit uses FULL durability');durableCommits++;return statement.run(...args)}}};
const a=identity('client-a'), b=identity('client-b');
mutations.describeAction=async(_user,operation,input)=>({operation,gymId,eventId:input.eventId||'event',targetSlotId:input.slotId||null,startAt:new Date(2000000000000).toISOString(),existingBookingIds:[]});
let writes=0, kind='uncertain';
mutations.book=async()=>{
  if(kind==='preflight') throw Object.assign(Error('unavailable'),{code:'CANCELLATION_STATE_UNAVAILABLE'});
  context.admitProvider(gymId,'POST');
  if(context.markMutationSubmitted)context.markMutationSubmitted(gymId,'POST');
  writes++; throw Error('response lost');
};
const run=(id,fn)=>context.run({identity:id,scope:'bookings:write',gymId,providerReads:true},fn);
async function prepare(id,key){const value=await actions.prepare(id,gymId,'book',{eventId:'event'},key,config);actions.decide(userId,value.actionId,true,config);return value.actionId;}
(async()=>{
  const first=await prepare(a,'first-request-0001'), second=await prepare(b,'second-request-001');
  assert.equal((await run(a,()=>actions.execute(a,first,config))).state,'unknown');
  await assert.rejects(()=>run(b,()=>actions.execute(b,second,config)), e=>e.code==='ACTION_UNCERTAIN', 'already-approved second client must not bypass uncertainty');
  assert.equal(writes,1);
  assert.equal(durableCommits,1); assert.equal(db.db.pragma('synchronous',{simple:true}),originalSync,'native sync mode restored after dispatch intent');
  db.db.prepare("UPDATE mcp_actions SET state='failed' WHERE id=?").run(first);
  kind='preflight';
  assert.equal((await run(b,()=>actions.execute(b,second,config))).state,'failed','definite pre-submission outage is failed, not uncertain');
  assert.equal(writes,1);
  const third=await prepare(a,'third-request-0001');
  assert.ok(third,'later actions are not frozen by a preflight failure');
  db.db.prepare("UPDATE mcp_actions SET state='executing',claimed_at=? WHERE id=?").run(Date.now()-31000,third);
  assert.equal((await actions.inspect(a,third,config)).state,'failed','restart without durable submission evidence is not uncertain');
  const provider=require('./providers').getProvider(gymId);
  provider.listBookingSnapshot=async()=>{throw Error('snapshot unavailable')};
  const cancel=await actions.prepare(a,gymId,'cancel',{bookingId:'target'},'cancel-preflight-001',config);actions.decide(userId,cancel.actionId,true,config);
  assert.equal((await run(a,()=>actions.execute(a,cancel.actionId,config))).state,'failed','real cancellation preflight outage is terminal before submission');
  assert.equal(writes,1);
  provider.listBookingSnapshot=async()=>({bookings:[{bookingId:'target',eventId:'event'}],complete:true});
  provider.cancelBooking=async()=>{context.admitProvider(gymId,'DELETE');context.markMutationSubmitted(gymId,'DELETE');writes++;throw Error('lost cancel response')};
  const uncertainCancel=await actions.prepare(a,gymId,'cancel',{bookingId:'target'},'cancel-uncertain-01',config);actions.decide(userId,uncertainCancel.actionId,true,config);
  assert.equal((await run(a,()=>actions.execute(a,uncertainCancel.actionId,config))).state,'unknown');
  provider.listBookingSnapshot=async()=>({bookings:[],complete:false});
  assert.equal((await actions.inspect(a,uncertainCancel.actionId,config)).state,'unknown','target omitted by a partial first page is not cancelled');
  provider.listBookingSnapshot=async()=>({bookings:[],complete:true});
  assert.equal((await actions.inspect(a,uncertainCancel.actionId,config)).state,'succeeded','only proven complete empty snapshot confirms cancellation');
  const raceA=await prepare(a,'race-request-a-0001'), raceB=await prepare(b,'race-request-b-0001');
  function child(actor,id){return new Promise((resolve,reject)=>{
    const code=`global.fetch=async()=>{throw Error('network forbidden')};
      const db=require('./server/db'),actions=require('./server/mcp/actions'),ctx=require('./server/mcp/context'),m=require('./server/normalized-mutations');
      m.describeAction=async()=>JSON.parse(db.db.prepare('SELECT summary_json FROM mcp_actions WHERE id=?').get(${JSON.stringify(id)}).summary_json);
      m.book=async()=>{ctx.admitProvider(${JSON.stringify(gymId)},'POST');ctx.markMutationSubmitted(${JSON.stringify(gymId)},'POST');await new Promise(r=>setTimeout(r,100));throw Error('uncertain')};
      ctx.run({identity:${JSON.stringify(actor)},scope:'bookings:write',gymId:${JSON.stringify(gymId)},providerReads:true},()=>actions.execute(${JSON.stringify(actor)},${JSON.stringify(id)},${JSON.stringify(config)})).then(r=>console.log(r.state)).catch(e=>console.log(e.code)).finally(()=>db.db.close());`;
    const p=require('node:child_process').spawn(process.execPath,['-e',code],{cwd:path.join(__dirname,'..'),env:process.env});let text='';p.stdout.on('data',c=>text+=c);p.stderr.resume();p.on('error',reject);p.on('exit',exit=>exit?reject(Error('race fixture failed')):resolve(text.trim().split('\n').pop()));
  })}
  const raced=await Promise.all([child(a,raceA),child(b,raceB)]);
  assert.deepEqual(raced.sort(),['ACTION_UNCERTAIN','unknown'],'separate processes racing distinct approvals cannot both submit');
  const count=db.db.prepare('SELECT count(*) n FROM mcp_action_submissions WHERE action_id IN (?,?)').get(raceA,raceB).n;
  assert.equal(count,1,'one durable submission across the process race');
  console.log('PASS action review: claim excludes another client uncertainty; preflight failure releases future work');
})().catch(e=>{console.error('FAIL action review:',e.message);process.exitCode=1}).finally(()=>{db.db.close();fs.rmSync(temp,{recursive:true,force:true})});
