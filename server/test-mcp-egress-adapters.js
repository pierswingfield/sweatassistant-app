// Actual normalized app reads -> admission -> broker -> real provider adapters.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'egress-adapters-'));process.env.DB_PATH=path.join(temp,'app.db');process.env.ENCRYPTION_KEY='b'.repeat(64);process.env.AARMY_ENABLED='true';
const original=fetch,owned=new Set();global.fetch=(u,o)=>{if(!owned.has(new URL(u).origin))throw Error('External network blocked');return original(u,o)};
const assert=require('node:assert/strict'),db=require('./db'),store=require('./mcp/store'),context=require('./mcp/context'),reads=require('./normalized-reads'),{createGateway}=require('./mcp-egress-gateway'),{catalog}=require('./mcp/tools');
const key='adapter-fixture-key-'.repeat(3);let broker,port,seen=[],reservationResults=[];
const respond=(data)=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
function actor(gymId){const userId=db.createAccount(`a${Math.random()}@example.test`,'fixture-password');db.linkGym(userId,gymId);db.runWithGymContext(userId,gymId,()=>db.updateUserJWT(userId,`fixture-session-${userId}`,new Date(Date.now()+600000).toISOString()));
 const identity={issuer:'https://fixture.example/',subject:`account:${userId}`,clientId:'adapter-fixture',scopes:['account:read','schedule:read'],expiresAt:Date.now()+600000};identity.grantId=store.createGrant({userId,...identity,gymIds:[gymId],consentReference:'fixture'});return{userId,identity};}
async function call(gymId,tool,args={}){const {userId,identity}=actor(gymId);return context.run({identity,scope:catalog[tool].scope,gymId,providerReads:true,tool},()=>db.runWithGymContext(userId,gymId,()=>catalog[tool].run({userId},{gymId,limit:1,offset:0,...args})));}
(async()=>{store.registerClient('adapter-fixture','Fixture');broker=createGateway({key,stateFile:path.join(temp,'broker.db'),fetchImpl:async(u,o)=>{seen.push({path:u.pathname,query:u.search,method:o.method});
 if(u.pathname.endsWith('/me/credits'))return respond({results:[{product_id:7,name:'Fixture pass',count:3}]});
 if(u.pathname.endsWith('/profile'))return respond({data:{id:1,available_credits:[{count:2,credit_type:{id:7,name:'Fixture pass'}}]}});
 if(u.pathname.endsWith('/heartbeat'))return respond({});
 // Sanitized live upcoming proof (2026-10-26); no top-level count/next.
 if(u.pathname.endsWith('/me/reservations'))return respond({results:reservationResults,meta:{pagination:{page:1,pages:1,count:reservationResults.length}},links:{next:null}});
 if(u.pathname.endsWith('/bookings'))return respond({data:[],meta:{current_page:1,last_page:1,total:0,per_page:100}});
 if(/\/classes\/[0-9]+$/.test(u.pathname))return respond({id:101,name:'Fixture class',start_datetime:'2026-11-01T12:00:00Z',booking_start_datetime:'2026-10-01T12:00:00Z',location:{id:1,timezone:'UTC'},class_type:{duration:45},layout:{spots:[]}});
 if(/\/events\/[0-9]+$/.test(u.pathname))return respond({data:{id:101,start_at:'2026-11-01T12:00:00Z',duration:45},slots:[],relations:{}});
 if(u.pathname.endsWith('/classes'))return respond({results:[],next:null,count:0});
 if(u.pathname.endsWith('/events'))return respond({data:[],relations:{}});
 throw Error('Unexpected fixture route');}});broker.listen(0,'127.0.0.1');await new Promise(r=>broker.once('listening',r));port=broker.address().port;owned.add(`http://127.0.0.1:${port}`);
 process.env.MCP_STANDING_EGRESS_ENABLED='true';process.env.MCP_EGRESS_URL=`http://127.0.0.1:${port}/`;process.env.MCP_EGRESS_KEY_FILE=path.join(temp,'key');fs.writeFileSync(process.env.MCP_EGRESS_KEY_FILE,key,{mode:0o600});
 const credits=await call('aarmy','get_credits');assert.equal(credits.metered,true);assert.equal(credits.credits[0].count,3);assert.ok(seen.some(x=>x.path.endsWith('/me/credits')));
 for(const gym of ['aarmy','psycle-london']){const b=await call(gym,'get_my_bookings');assert.equal(b.completeness.complete,true);await call(gym,'get_class_details',{eventId:'101'});await call(gym,'search_classes',{startDate:'2026-11-01',endDate:'2026-11-01'});}
 reservationResults=[{id:'invalid!',reservation_type:'standard'}];
 assert.equal((await call('aarmy','get_my_bookings')).completeness.complete,false,'nested count proof cannot bypass normalized booking ID validation');
 const invalid=actor('aarmy');
 const snapshot=await context.run({identity:invalid.identity,scope:'account:read',gymId:'aarmy',providerReads:true,tool:'get_my_bookings'},()=>db.runWithGymContext(invalid.userId,'aarmy',()=>reads.bookingSnapshot(invalid.userId)));
 assert.equal(snapshot.complete,false,'the fresh action snapshot also rejects invalid identifiers');
 reservationResults=[];
 assert.equal((await call('psycle-london','get_credits')).credits[0].count,2);
 assert.ok(db.db.prepare("SELECT count(*) n FROM mcp_budgets WHERE budget_key LIKE 'provider:user:%' AND count>0").get().n>=6);
 const policy=require('./providers/egress-policy');
 const base={gymId:'aarmy',tool:'get_credits',scope:'account:read',url:'https://aarmy.marianatek.com/api/customer/v1/me/credits',method:'GET',headers:{authorization:'Bearer fixture-session'},body:null};
 for(const changes of [{tool:'search_classes',scope:'schedule:read'},{scope:'schedule:read'},{url:base.url+'?page=1'},{url:base.url.replace('/credits','/account')}])assert.throws(()=>policy.validate({...base,...changes}));
 console.log('PASS real-adapter metered credits, cached completeness, timetable and durable admission');
})().catch(e=>{console.error('FAIL adapter egress:',e.message);process.exitCode=1}).finally(async()=>{if(broker)await new Promise(r=>broker.close(r));db.db.close();fs.rmSync(temp,{recursive:true,force:true})});
