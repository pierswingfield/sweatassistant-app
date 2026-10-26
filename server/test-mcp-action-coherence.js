// Exact paused-penalty/native-write race; fixtures never contact the network.
global.fetch=async()=>{throw Error('External network blocked')};
process.env.DB_PATH=':memory:';process.env.ENCRYPTION_KEY='b'.repeat(64);process.env.JAB_BOXING_ENABLED='true';
const assert=require('node:assert/strict'),db=require('./db'),store=require('./mcp/store'),access=require('./mcp/access'),context=require('./mcp/context'),actions=require('./mcp/actions'),{getProvider}=require('./providers'),{timedProviderFetch}=require('./logger');
require('./calendar').scheduleRefresh=()=>{};
const gymId='jab-boxing',provider=getProvider(gymId),config={writesEnabled:true,providerReads:true,resource:'https://fixture.example/mcp'};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};
let sequence=0,penaltyGate,penaltyEntered,snapshots=0,dispatches=0;
provider.listBookingSnapshot=async()=>{snapshots++;return{bookings:[{bookingId:'900',eventId:'101',slotId:'53'}],complete:true}};
provider.fetchEventDetails=async()=>({event:{id:'101',name:'Fixture',startAt:new Date(Date.now()+86400000).toISOString(),timeZone:'UTC'},slots:[]});
provider.getCancelPenalty=async()=>{if(penaltyGate){penaltyEntered.resolve();await penaltyGate.promise;}return{penalty:'none'}};
provider.cancelBooking=async()=>{context.markMutationSubmitted(gymId,'POST');dispatches++;return true};
store.registerClient('coherence','Fixture');
function actor(){const userId=db.createAccount(`fixture${sequence++}@example.test`,'fixture-password');db.linkGym(userId,gymId);db.runWithGymContext(userId,gymId,()=>db.updateUserJWT(userId,'fixture-token',new Date(Date.now()+600000).toISOString()));access.setWritePreference(userId,true);const identity={issuer:'https://fixture.example/',subject:`account:${userId}`,clientId:'coherence',scopes:['account:read','schedule:read','bookings:write'],expiresAt:Date.now()+600000};identity.grantId=store.createGrant({userId,...identity,gymIds:[gymId],consentReference:'fixture'});return{userId,identity};}
const run=(a,tool,fn)=>context.run({identity:a.identity,scope:'bookings:write',gymId,providerReads:true,tool},()=>db.runWithGymContext(a.userId,gymId,fn));
async function prepare(){const a=actor();const result=await run(a,'prepare_booking_cancel',()=>actions.prepare(a.identity,gymId,'cancel',{bookingId:'900'},`request-${String(sequence).padStart(16,'0')}`,config));actions.decide(a.userId,result.actionId,true,config);return{...a,id:result.actionId};}
(async()=>{
 for(const completed of [false,true]){
  penaltyGate=null;const a=await prepare(),before=dispatches;penaltyGate=deferred();penaltyEntered=deferred();
  const execution=run(a,'execute_booking_action',()=>actions.execute(a.identity,a.id,config));await penaltyEntered.promise;
  // Start through the real shared mutation transport; no guest edge exists yet.
  const nativeGate=deferred(),entered=deferred();const native=timedProviderFetch(gymId,'POST','/fixture-native-guest',async()=>{entered.resolve();await nativeGate.promise;return new Response('{}')});await entered.promise;
  if(completed){nativeGate.resolve();await native;}
  penaltyGate.resolve();const result=await execution;
  assert.equal(result.state,'failed',completed?'completed native write invalidates baseline':'active native guest write invalidates baseline');
  assert.equal(dispatches,before,'MCP primary cancellation never reaches transport');
  if(!completed){nativeGate.resolve();await native;}
 }
 penaltyGate=null;const a=await prepare(),beforeSnapshots=snapshots;const result=await run(a,'execute_booking_action',()=>actions.execute(a.identity,a.id,config));assert.equal(result.state,'succeeded');assert.equal(snapshots,beforeSnapshots+1,'unaffected execution reuses only its own fresh complete snapshot');
 console.log('PASS action coherence: paused penalty rejects active/completed native writes; unaffected execution reuses fresh baseline');
})().catch(e=>{console.error('FAIL action coherence:',e.message);process.exitCode=1}).finally(()=>db.db.close());
