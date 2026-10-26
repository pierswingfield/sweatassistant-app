// Real local HTTP broker/upstream only; all non-owned outbound fetch is blocked.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-egress-'));
process.env.DB_PATH=path.join(temp,'app.db');process.env.ENCRYPTION_KEY='b'.repeat(64);process.env.JAB_BOXING_ENABLED='false';
const nativeFetch=global.fetch,owned=new Set();global.fetch=(url,opts)=>{if(!owned.has(new URL(url).origin))throw Error('Forbidden non-owned network');return nativeFetch(url,opts)};
const assert=require('node:assert/strict'),{createGateway}=require('./mcp-egress-gateway'),proof=require('./mcp/egress-proof'),db=require('./db');
const key='fixture-key-'.repeat(4),stateFile=path.join(temp,'broker.db');let gateway,upstream,port,count=0,held,checks=0;
const check=(value,label)=>{assert.ok(value,label);checks++};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function listen(server){server.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return server.address().port;}
async function close(server){if(server)await new Promise(r=>server.close(r));}
function input(account='a',gymId='psycle-london',tool='get_my_bookings',url='https://psycle.codexfit.com/api/v1/customer/bookings?limit=100&page=1'){
 const target=new URL(url);target.searchParams.sort();return {gymId,account:proof.mac(key,account),tool,scope:'account:read',url:target.href,method:'GET',headers:{authorization:'Bearer fixture-session',accept:'application/json'},body:null,issuedAt:Date.now(),nonce:crypto.randomBytes(16).toString('hex')};
}
function send(value,signature=proof.sign(key,value),extra={}){return new Promise((resolve,reject)=>{const req=http.request(`http://127.0.0.1:${port}/provider-request`,{method:'POST',headers:{'content-type':'application/json','x-mcp-egress-signature':signature,...extra}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text)}catch(_){}resolve({status:res.statusCode,data})})});req.on('error',reject);req.end(JSON.stringify(value))})}
(async()=>{
 upstream=http.createServer((req,res)=>{count++;if(req.url.includes('/profile')){held=res;return;}res.writeHead(200,{'content-type':'application/json'}).end('[]')});
 const upPort=await listen(upstream);owned.add(`http://127.0.0.1:${upPort}`);
 const fetchImpl=(url,options)=>fetch(`http://127.0.0.1:${upPort}${url.pathname}${url.search}`,options);
 gateway=createGateway({key,stateFile,fetchImpl,deadlineMs:300});port=await listen(gateway);owned.add(`http://127.0.0.1:${port}`);
 const first=input();check((await send(first)).status===200&&count===1,'valid signed bounded read reaches owned upstream');
 check((await send({...input(),account:proof.mac(key,'spoof')},proof.sign(key,input()))).status===403&&count===1,'changed account/context cannot reuse proof');
 for(const change of [
  {scope:'schedule:read'}, {method:'POST'}, {body:'secret'}, {url:'https://evil.example/api/v1/customer/bookings?limit=100&page=1'},
  {url:'https://psycle.codexfit.com/api/v1/customer/bookings?limit=100&page=2'},
  {url:'https://psycle.codexfit.com/api/v1/customer/bookings?limit=100&page=1&page=1'},
  {url:'https://psycle.codexfit.com/api/v1/customer/%62ookings?limit=100&page=1'},
  {url:'https://psycle.codexfit.com/api/v1/customer/bookings?limit=100&page=1#x'},
  {headers:{authorization:'Bearer fixture-session','x-forwarded-for':'1.2.3.4'}}, {issuedAt:Date.now()-16000},
 ])check((await send({...input(),...change})).status===403,'host/method/scope/query/header/expiry policy rejects invalid receipt');
 check(count===1,'denied requests never contact upstream');
 check((await send(first)).status===403&&count===1,'receipt is consumed once');
 const pending=send(input('a','psycle-london','get_credits','https://psycle.codexfit.com/api/v1/customer/profile'));
 for(let n=0;n<50&&!held;n++)await wait(2);
 const otherGym=input('a','jab-boxing','get_my_bookings','https://jabboxingclub.marianatek.com/api/customer/v1/me/reservations?is_upcoming=true&page_size=100');
 check((await send(otherGym)).status===429,'one account flight spans gyms');
 check((await send(input('b'))).status===200,'another account remains independent');
 check((await pending).status===502,'stalled body/header request is bounded by deadline');held.destroy();held=null;
 check((await send(input('a'))).status===200,'deadline releases account slot');
 const previous=port;await close(gateway);owned.delete(`http://127.0.0.1:${previous}`);
 gateway=createGateway({key,stateFile,fetchImpl,deadlineMs:300});port=await listen(gateway);owned.add(`http://127.0.0.1:${port}`);
 check((await send(first)).status===403,'replay ledger survives broker restart');
 // Exercise the production shared admitted app transport, not a free-standing signer.
 process.env.MCP_STANDING_EGRESS_ENABLED='true';process.env.MCP_EGRESS_URL=`http://127.0.0.1:${port}/`;process.env.MCP_EGRESS_KEY_FILE=path.join(temp,'key');fs.writeFileSync(process.env.MCP_EGRESS_KEY_FILE,key,{mode:0o600});
 const userId=db.createAccount('egress@example.test','fixture-password'),gymId='psycle-london';db.linkGym(userId,gymId);
 db.runWithGymContext(userId,gymId,()=>db.updateUserJWT(userId,'fixture-session',new Date(Date.now()+600000).toISOString()));
 const store=require('./mcp/store');store.registerClient('fixture','Fixture');const identity={issuer:'https://fixture.example/',subject:`account:${userId}`,clientId:'fixture',scopes:['account:read'],expiresAt:Date.now()+600000};
 identity.grantId=store.createGrant({userId,...identity,gymIds:[gymId],consentReference:'fixture'});
 const context=require('./mcp/context'),{providerFetch}=require('./logger');
 const call=()=>context.run({identity,scope:'account:read',gymId,providerReads:true,tool:'get_my_bookings'},()=>db.runWithGymContext(userId,gymId,()=>providerFetch(gymId,input().url,{headers:{authorization:'Bearer fixture-session',accept:'application/json'}})));
 const before=count;for(let n=0;n<6;n++)check((await call()).status===200,'shared admitted transport forwards one charged receipt');
 await assert.rejects(call,e=>e.code==='RATE_LIMITED');checks++;
 check(count===before+6,'existing durable MCP account budget bounds broker traffic');
 const rows=db.db.prepare("SELECT count FROM mcp_budgets WHERE budget_key=?").all(`provider:user:${userId}:${gymId}`);
 check(rows.some(r=>r.count===6),'budget is persisted in the app ledger rather than duplicated at broker');
 console.log(`PASS standing egress: ${checks} actual HTTP policy/context/replay/deadline/admission checks`);
})().catch(e=>{console.error('FAIL standing egress:',e.message);process.exitCode=1}).finally(async()=>{if(held)held.destroy();await close(gateway);await close(upstream);db.db.close();fs.rmSync(temp,{recursive:true,force:true})});
