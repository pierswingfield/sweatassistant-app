// Only called inside timedProviderFetch's admitted transport callback.
const fs=require('node:fs'),crypto=require('node:crypto');
const proof=require('./egress-proof'),policy=require('../providers/egress-policy');
function enabled(){return process.env.MCP_STANDING_EGRESS_ENABLED==='true';}
function configuration(){
  const key=proof.readKey(process.env.MCP_EGRESS_KEY_FILE);
  const url=new URL(process.env.MCP_EGRESS_URL);
  if(key.length<32||url.protocol!=='http:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['mcp-provider-egress','127.0.0.1'].includes(url.hostname))throw Error('Invalid private egress configuration');
  return {key,url:new URL('/provider-request',url).href};
}
async function forward(gymId,url,options,signal,{key,url:brokerUrl}=configuration()){
  const context=require('./context').current();
  if(!context?.active||context.controller.signal.aborted||context.gymId!==gymId||!context.providerReads)throw Error('Unadmitted egress actor');
  const actor=require('./store').authorize(context.identity,context.scope,gymId);
  const ctx=require('../normalized-reads').resolveContext(actor.userId);
  const headers=Object.fromEntries(new Headers(options.headers||{}));
  if(headers.authorization&&headers.authorization!==`Bearer ${ctx.session.accessToken}`)throw Error('Foreign provider credential');
  const target=new URL(url);target.searchParams.sort();
  const input={gymId,account:proof.mac(key,`account:${actor.userId}`),tool:context.tool,scope:context.scope,
    url:target.href,method:options.method||'GET',headers,body:options.body??null,issuedAt:Date.now(),nonce:crypto.randomBytes(16).toString('hex')};
  if(context.actionPolicy){
    for(const scope of ['bookings:write','account:read','schedule:read'])require('./store').authorize(context.identity,scope,gymId);
    const mutation=input.method!=='GET';
    if(mutation){
      if(process.env.MCP_EGRESS_WRITES_ENABLED!=='true'||!context.writeSubmitted||!context.writeAuthorization)throw Error('Standing egress writes are disabled');
      context.writeAuthorization(gymId);
    }
    input.action={...context.actionPolicy,input:{...context.actionPolicy.input},submitted:mutation&&context.writeSubmitted===true};
    input.authorization={grant:proof.mac(key,`grant:${context.identity.grantId}`),client:proof.mac(key,`client:${context.identity.clientId}`),
      scopes:[...context.identity.scopes].sort(),credential:crypto.createHash('sha256').update(headers.authorization||'').digest('hex'),bodyHash:crypto.createHash('sha256').update(input.body||'').digest('hex')};
  } else if(input.method!=='GET'||input.body!==null)throw Error('Standing egress is read-only');
  policy.validate(input);
  const response=await fetch(brokerUrl,{method:'POST',headers:{'content-type':'application/json','x-mcp-egress-signature':proof.sign(key,input)},body:JSON.stringify(input),redirect:'manual',signal});
  if(!response.ok)throw Object.assign(Error('Private egress refused request'),{code:'PROVIDER_WORK_DISABLED',status:response.status===429?429:503});
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>6*1024*1024)throw Error('Egress response limit');chunks.push(Buffer.from(value));}}finally{reader.cancel().catch(()=>{});}
  const text=Buffer.concat(chunks).toString();
  const payload=JSON.parse(text);
  if(!Number.isInteger(payload.status)||payload.status<200||payload.status>599||typeof payload.body!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(payload.body)||
    !payload.headers||typeof payload.headers!=='object'||Array.isArray(payload.headers)||Object.keys(payload.headers).some(k=>!['content-type','retry-after'].includes(k)))throw Error('Invalid egress response');
  const bytes=Buffer.from(payload.body,'base64');if(bytes.length>4*1024*1024)throw Error('Egress response limit');
  return new Response([204,205,304].includes(payload.status)?null:bytes,{status:payload.status,headers:payload.headers});
}
// Within one action only, reuse successful detail/payment reads for five seconds.
// Snapshots are never memoized. This prevents adapter preflight duplication from
// exhausting the six-hop ceiling; cache hits still recheck current authorization.
async function actionRead(gymId,url,options,load){
  const c=require('./context').current();
  if(!c?.actionPolicy||(options.method||'GET')!=='GET'||options.body!=null||!policy.cacheableActionRead(gymId,url,c.actionPolicy))return load();
  const authorize=()=>{
    if(!c.active||c.controller.signal.aborted||c.gymId!==gymId)throw Error('Expired action read');
    for(const scope of ['bookings:write','account:read','schedule:read'])require('./store').authorize(c.identity,scope,gymId);
    const ctx=require('../normalized-reads').resolveContext(c.actor.userId);
    if(new Headers(options.headers).get('authorization')!==`Bearer ${ctx.session.accessToken}`)throw Error('Changed action credential');
  };
  authorize();
  const cache=c.actionReadMemo||(c.actionReadMemo=new Map()),key=JSON.stringify([url,Object.fromEntries(new Headers(options.headers))]);
  const hit=cache.get(key);if(hit&&hit.expires>Date.now()){hit.coherent();const value=await hit.value;authorize();hit.coherent();return value.clone();}
  const entry={expires:Date.now()+5000,value:null,coherent:require('../private-read-cache').checkpoint(gymId)};
  entry.value=Promise.resolve().then(load).then(res=>{if(!res.ok)cache.delete(key);return res;},error=>{cache.delete(key);throw error;});
  if(cache.size<6)cache.set(key,entry);
  const value=await entry.value;authorize();entry.coherent();return value.clone();
}
module.exports={enabled,forward,actionRead};
