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
    url:target.href,method:options.method||'GET',headers,body:null,issuedAt:Date.now(),nonce:crypto.randomBytes(16).toString('hex')};
  if(options.body!=null)throw Error('Standing egress is read-only');
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
  return new Response(bytes,{status:payload.status,headers:payload.headers});
}
module.exports={enabled,forward};
