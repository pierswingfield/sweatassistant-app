// Real adapters/shared actions/private HTTP broker; no external fetch permitted.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'egress-actions-'));process.env.DB_PATH=path.join(dir,'app.db');process.env.ENCRYPTION_KEY='b'.repeat(64);process.env.JAB_BOXING_ENABLED='true';process.env.MCP_EGRESS_WRITES_ENABLED='true';
const nativeFetch=fetch,owned=new Set();global.fetch=(u,o)=>{if(!owned.has(new URL(u).origin))throw Error('External network blocked');return nativeFetch(u,o)};
const assert=require('node:assert/strict'),db=require('./db'),store=require('./mcp/store'),access=require('./mcp/access'),context=require('./mcp/context'),actions=require('./mcp/actions'),proof=require('./mcp/egress-proof'),{createGateway}=require('./mcp-egress-gateway');
require('./calendar').scheduleRefresh=()=>{};
const key='action-broker-fixture-'.repeat(3),ledger=path.join(dir,'broker.db'),config={writesEnabled:true,providerReads:true,resource:'https://fixture.example/mcp'};
const now=Date.now;let clock=0;Date.now=()=>now()+clock;
let hops=[];let gateway,port,scenario,mutations=0,lastReceipt,requestId=0,checks=0;
const good=(value,label)=>{assert.ok(value,label);checks++};
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const event={id:101,name:'Fixture class',start_at:'2027-12-01T12:00:00Z',duration:45,required_credits:1,studio_id:1};
const mtClass={id:101,name:'Fixture class',start_datetime:event.start_at,booking_start_datetime:'2026-01-01T00:00:00Z',available_spot_count:4,is_user_reserved:false,location:{id:1},classroom:{id:1},class_type:{duration:45},layout:{spots:[{id:'53',name:'53',is_available:true},{id:'54',name:'54',is_available:true}]}};
function snapshot(mt){const rows=scenario.operation==='book'?[]:mt?[{id:'900',reservation_type:'standard',class_session:mtClass,spot:{id:scenario.currentSlot||'53'},is_booked_for_me:true}]:[{id:900,event_id:101,event,slot:Number(scenario.currentSlot||53)}];return mt?{results:rows,count:rows.length,next:null}:{data:rows,meta:{current_page:1,last_page:1,total:rows.length,per_page:100}};}
async function upstream(u,o){hops.push(o.method+' '+u.pathname);const p=u.pathname,mt=u.hostname.includes('marianatek');
 if(o.method!=='GET'){
  mutations++;assert.ok(db.db.prepare('SELECT 1 FROM mcp_action_submissions WHERE action_id=?').get(scenario.actionId),'submission intent exists before transport');
  if(scenario.lost)throw Error('Synthetic lost response after submission');
  if(scenario.refused)return new Response(JSON.stringify({error:'refused'}),{status:409});
  if(scenario.operation==='cancel')return json({});
  return json(mt?{id:'900',spot:{id:scenario.operation==='edit'?'54':'53'}}:{success:true,bookings:{900:53},slot:54});
 }
 if(p.endsWith('/profile'))return json({data:{id:1,available_credits:[]}});
 if(p.endsWith('/heartbeat'))return json({});
 if(p.endsWith('/me/reservations')||p.endsWith('/bookings'))return json(snapshot(mt));
 if(p.endsWith('/payment_options'))return json({user_payment_options:[{id:'membership-123',membership_payment:{}}],guest_payment_options:[]});
 if(p.endsWith('/cancel_penalty'))return json({is_penalty_cancel:false});
 if(p.endsWith('/classes/101'))return json(mtClass);
 if(p.endsWith('/events/101'))return json({data:event,slots:[53,54],relations:{studios:[{id:1,layout:{slots:[{id:53,name:'53'},{id:54,name:'54'}]}}]}});
 throw Error('Unexpected local fixture route');
}
async function start(writesEnabled){gateway=createGateway({key,stateFile:ledger,fetchImpl:upstream,writesEnabled});gateway.listen(0,'127.0.0.1');await new Promise(r=>gateway.once('listening',r));port=gateway.address().port;owned.add(`http://127.0.0.1:${port}`);process.env.MCP_EGRESS_URL=`http://127.0.0.1:${port}/`;}
async function stop(){if(gateway){owned.delete(`http://127.0.0.1:${port}`);await new Promise(r=>gateway.close(r));gateway=null;}}
function actor(gymId){const userId=db.createAccount(`fixture${requestId++}@example.test`,'fixture-password');db.linkGym(userId,gymId);db.runWithGymContext(userId,gymId,()=>db.updateUserJWT(userId,`fixture-session-${userId}`,new Date(Date.now()+3600000).toISOString()));access.setWritePreference(userId,true);
 const identity={issuer:'https://fixture.example/',subject:`account:${userId}`,clientId:'actions',scopes:['schedule:read','account:read','bookings:write'],expiresAt:Date.now()+3600000};identity.grantId=store.createGrant({userId,...identity,gymIds:[gymId],consentReference:'fixture'});return{userId,identity,gymId};}
function run(a,tool,fn){return context.run({identity:a.identity,scope:'bookings:write',gymId:a.gymId,providerReads:true,tool},()=>db.runWithGymContext(a.userId,a.gymId,fn));}
async function action(gymId,operation,extra={}){clock+=61000;scenario={operation,...extra};const a=actor(gymId),input=operation==='book'?{eventId:'101',slotId:'53'}:operation==='edit'?{bookingId:'900',currentSlotId:'53',slotId:'54'}:{bookingId:'900'};
 const tool={book:'prepare_booking',edit:'prepare_booking_edit',cancel:'prepare_booking_cancel'}[operation];
 const prepared=await run(a,tool,()=>actions.prepare(a.identity,gymId,operation,input,`request-key-${String(requestId).padStart(10,'0')}`,config));scenario.actionId=prepared.actionId;actions.decide(a.userId,prepared.actionId,true,config);
 const before=mutations;const result=await run(a,'execute_booking_action',()=>actions.execute(a.identity,prepared.actionId,config,gymId));
 return{a,result,before,prepared};}
function send(input,signature=proof.sign(key,input)){return new Promise((resolve,reject)=>{const r=http.request(`http://127.0.0.1:${port}/provider-request`,{method:'POST',headers:{'content-type':'application/json','x-mcp-egress-signature':signature}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode))});r.on('error',reject);r.end(JSON.stringify(input));});}
(async()=>{store.registerClient('actions','Fixture');process.env.MCP_STANDING_EGRESS_ENABLED='true';process.env.MCP_EGRESS_KEY_FILE=path.join(dir,'key');fs.writeFileSync(process.env.MCP_EGRESS_KEY_FILE,key,{mode:0o600});
 // Capture only this synthetic fixture's own signed requests for replay checks.
 global.fetch=(u,o)=>{if(!owned.has(new URL(u).origin))throw Error('External network blocked');const v=JSON.parse(o.body);if(v.method!=='GET')lastReceipt=v;return nativeFetch(u,o)};
 await start(true);
 for(const gymId of ['psycle-london','jab-boxing'])for(const operation of ['book','edit','cancel']){
  const r=await action(gymId,operation);good(r.result.state==='succeeded',`${gymId} ${operation} succeeds through actual adapters (${r.result.state}; ${hops.slice(-10).join(',')})`);good(mutations===r.before+1,'one mutation only');
  good((await run(r.a,'execute_booking_action',()=>actions.execute(r.a.identity,r.prepared.actionId,config))).state==='succeeded','repeat returns durable result');good(mutations===r.before+1,'repeat never resubmits');
 }
 const prior=mutations,receipt=lastReceipt;
 const fresh=()=>({...receipt,issuedAt:Date.now(),nonce:crypto.randomBytes(16).toString('hex'),action:{...receipt.action,id:crypto.randomUUID()}});
 for(const change of [v=>({...v,url:v.url+'?override=true'}),v=>({...v,scope:'account:read'}),v=>({...v,tool:'get_my_bookings'}),v=>({...v,action:{...v.action,submitted:false}}),v=>({...v,action:{...v.action,input:{bookingId:'foreign'}}}),v=>({...v,authorization:{...v.authorization,scopes:['bookings:write']}}),v=>({...v,headers:{authorization:'Bearer foreign'}}),v=>({...v,body:'{"amount":1}'})])good(await send(change(fresh()))===403,'malicious query/body/action/credential/scope is denied');
 const changed=fresh();good(await send(changed,proof.sign(key,{...changed,nonce:'0'.repeat(32)}))===403,'signature binds every action receipt field');good(mutations===prior,'malformed action receipts never reach mutation transport');
 good(await send({...receipt,issuedAt:Date.now(),nonce:crypto.randomBytes(16).toString('hex')})===403,'new nonce cannot replay same action');good(mutations===prior,'replay has no provider effect');
 await stop();await start(true);good(await send({...receipt,issuedAt:Date.now(),nonce:crypto.randomBytes(16).toString('hex')})===403,'action replay survives restart');
 const lost=await action('psycle-london','book',{lost:true});good(lost.result.state==='unknown','lost response remains unknown');good(mutations===lost.before+1,'lost response one submission');
 good((await run(lost.a,'execute_booking_action',()=>actions.execute(lost.a.identity,lost.prepared.actionId,config))).state==='unknown','unknown action never resubmits');
 process.env.MCP_EGRESS_WRITES_ENABLED='false';const preblocked=await action('psycle-london','edit');good(preblocked.result.state==='failed'&&mutations===preblocked.before,'disabled app write path fails before submission');process.env.MCP_EGRESS_WRITES_ENABLED='true';
 await stop();await start();const denied=await action('psycle-london','edit');good(denied.result.state!=='succeeded'&&mutations===denied.before,'default-readonly broker refuses action mutation');
 console.log(`PASS broker action integration: ${checks} actual adapter/shared-service HTTP checks`);
})().catch(e=>{console.error('FAIL broker action integration:',e.message);process.exitCode=1}).finally(async()=>{Date.now=now;await stop();db.db.close();fs.rmSync(dir,{recursive:true,force:true})});
