// Adaptive anonymous-only abuse control. Valid authenticated accounts never
// inherit a shared hosted-client IP ban; their durable account budgets apply.
const crypto=require('node:crypto'),net=require('node:net');
function normalize(ip){if(typeof ip!=='string')return null;const value=ip.startsWith('::ffff:')?ip.slice(7):ip;return net.isIP(value)?value:null;}
function clientIP(req,trusted=[]){
  const peer=normalize(req.socket?.remoteAddress)||'unknown';
  const configured=trusted.map(normalize);if(configured.some(ip=>!ip))throw Error('Trusted proxy addresses must be exact IP literals');
  const cf=req.headers['cf-connecting-ip'];return configured.includes(peer)&&normalize(cf)?normalize(cf):peer;
}
function createGuard({clock=Date.now,maxEntries=4096,threshold=20,windowMs=60000,baseBanMs=300000,maxBanMs=3600000}={}){
  const salt=crypto.randomBytes(32),ips=new Map(),tokens=new Map();
  const key=value=>crypto.createHmac('sha256',salt).update(String(value)).digest('hex');
  function bounded(map){const now=clock();for(const[k,v]of map)if(v.expires<=now)map.delete(k);while(map.size>=maxEntries)map.delete(map.keys().next().value);}
  function banned(ip){const row=ips.get(key(ip));return row?.until>clock()?Math.max(1,Math.ceil((row.until-clock())/1000)):0;}
  function cached(token){const entry=tokens.get(key(token));return entry?.expires>clock();}
  function failure(ip,token){
    bounded(ips);bounded(tokens);const now=clock(),id=key(ip);let row=ips.get(id)||{start:now,count:0,strikes:0,until:0};
    if(now-row.start>=windowMs){row.start=now;row.count=0;}row.count++;
    if(row.count>=threshold&&row.until<=now){row.until=now+Math.min(maxBanMs,baseBanMs*2**Math.min(row.strikes,10));row.strikes++;}
    row.expires=now+maxBanMs;ips.set(id,row);if(token)tokens.set(key(token),{expires:now+windowMs});return banned(ip);
  }
  return {banned,cached,failure,size:()=>({ips:ips.size,tokens:tokens.size})};
}
module.exports={clientIP,createGuard};
