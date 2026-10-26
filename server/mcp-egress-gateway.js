// Private broker: signed app admission receipts, read-only registry policy.
const http=require('node:http'), crypto=require('node:crypto'), Database=require('better-sqlite3');
const proof=require('./mcp/egress-proof'),policy=require('./providers/egress-policy');
function createGateway({key,stateFile,fetchImpl=fetch,deadlineMs=10000,writesEnabled=false}={}){
  if(typeof key!=='string'||key.length<32||!stateFile)throw Error('Private key and separate ledger are required');
  const ledger=new Database(stateFile);
  if(ledger.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('receipts','mutations','sqlite_sequence')").all().length){ledger.close();throw Error('A dedicated replay ledger is required');}
  if(stateFile!==':memory:')require('node:fs').chmodSync(stateFile,0o600);
  ledger.pragma('journal_mode=WAL');ledger.pragma('synchronous=FULL');
  ledger.exec('CREATE TABLE IF NOT EXISTS receipts(nonce TEXT PRIMARY KEY,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS mutations(action TEXT PRIMARY KEY,submitted_at INTEGER NOT NULL)');
  const consume=ledger.transaction(input=>{
    ledger.prepare('DELETE FROM receipts WHERE expires_at<=?').run(Date.now());
    if(ledger.prepare('SELECT count(*) n FROM receipts').get().n>=10000)throw Error('Ledger capacity');
    if(input.method!=='GET'){
      if(ledger.prepare('SELECT count(*) n FROM mutations').get().n>=100000)throw Error('Mutation ledger capacity');
      ledger.prepare('INSERT INTO mutations(action,submitted_at) VALUES (?,?)').run(proof.mac(key,`action:${input.account}:${input.action.id}`),Date.now());
    }
    ledger.prepare('INSERT INTO receipts(nonce,expires_at) VALUES (?,?)').run(crypto.createHash('sha256').update(input.nonce).digest('hex'),Date.now()+60000);
  });
  const active=new Set();
  const server=http.createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');
    if(req.method!=='POST'||req.url!=='/provider-request'){res.writeHead(404).end();return;}
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),deadlineMs);
    const disconnect=()=>controller.abort();const close=()=>{if(!res.writableEnded)disconnect()};
    req.once('aborted',disconnect);res.once('close',close);
    let account,status=403;
    try{
      const bytes=await boundedRequest(req,controller.signal,16384);
      const input=JSON.parse(bytes.toString());proof.verify(key,input,req.headers['x-mcp-egress-signature']);
      const {target,headers}=policy.validate(input);
      if(input.method!=='GET'&&!writesEnabled)throw Error('Writes disabled');
      if(active.has(input.account)){status=429;throw Error('Busy account');}
      consume(input);active.add(input.account);account=input.account;
      status=502;
      const upstream=await aborted(fetchImpl(target,{method:input.method,headers,...(input.body!==null?{body:input.body}:{}),redirect:'manual',signal:controller.signal}),controller.signal);
      const body=await boundedResponse(upstream,controller.signal,4*1024*1024);
      const responseHeaders={};for(const h of ['content-type','retry-after']){const v=upstream.headers.get(h);if(v&&v.length<=256)responseHeaders[h]=v;}
      if(!res.destroyed&&!res.writableEnded)res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({status:upstream.status,headers:responseHeaders,body:body.toString('base64')}));
    }catch(_){if(!res.destroyed&&!res.writableEnded){if(!req.complete)res.setHeader('connection','close');res.writeHead(status).end('{"error":"egress denied"}');}}
    finally{clearTimeout(timer);req.off('aborted',disconnect);res.off('close',close);if(account)active.delete(account);}
  });
  server.headersTimeout=10000;server.requestTimeout=10000;server.maxConnections=64;
  server.once('close',()=>ledger.close());return server;
}
function aborted(promise,signal){return new Promise((resolve,reject)=>{const abort=()=>reject(Error('Deadline'));if(signal.aborted){Promise.resolve(promise).catch(()=>{});abort();return;}signal.addEventListener('abort',abort,{once:true});Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
function boundedRequest(req,signal,max){return new Promise((resolve,reject)=>{let size=0,chunks=[],done=false;
 const end=(error)=>{if(done)return;done=true;req.off('data',data);req.off('end',finish);signal.removeEventListener('abort',abort);error?(req.pause(),reject(error)):resolve(Buffer.concat(chunks));};
 const data=c=>{size+=c.length;if(size>max)end(Error('Body limit'));else chunks.push(c)};const finish=()=>end(),abort=()=>end(Error('Deadline')),error=e=>end(e);
 req.on('data',data);req.once('end',finish);req.on('error',error);req.once('close',()=>req.off('error',error));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
async function boundedResponse(response,signal,max){const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);const chunks=[];let size=0;try{while(true){const {done,value}=await aborted(reader.read(),signal);if(done)break;size+=value.byteLength;if(size>max)throw Error('Response limit');chunks.push(Buffer.from(value));}return Buffer.concat(chunks);}finally{reader.cancel().catch(()=>{});}}
if(require.main===module){const fs=require('node:fs');createGateway({key:proof.readKey(process.env.MCP_EGRESS_KEY_FILE),stateFile:process.env.MCP_EGRESS_STATE_FILE,writesEnabled:process.env.MCP_EGRESS_WRITES_ENABLED==='true'}).listen(Number(process.env.MCP_EGRESS_PORT||3101),process.env.MCP_EGRESS_BIND_ADDRESS||'127.0.0.1');}
module.exports={createGateway};
