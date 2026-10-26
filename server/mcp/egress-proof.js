const crypto=require('node:crypto');
const fields=['gymId','account','tool','scope','url','method','headers','body','issuedAt','nonce'];
function mac(key,text){return crypto.createHmac('sha256',key).update(text).digest('hex');}
function sign(key,input){return mac(key,JSON.stringify(input));}
function verify(key,input,signature,now=Date.now()){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!fields.includes(k)&&!['authorization','action'].includes(k))||fields.some(k=>!Object.hasOwn(input,k))||
    !/^[a-f0-9]{64}$/.test(input.account||'')||!/^[a-f0-9]{32}$/.test(input.nonce||'')||!Number.isSafeInteger(input.issuedAt)||
    input.issuedAt>now+5000||now-input.issuedAt>15000||typeof input.url!=='string'||input.url.length>4096||
    typeof input.gymId!=='string'||input.gymId.length>100||typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature))throw Error('Invalid receipt');
  const expected=sign(key,input);if(!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))throw Error('Invalid receipt');
}
function readKey(file){const fs=require('node:fs');if((fs.statSync(file).mode&0o077)!==0)throw Error('Egress key must be private');const value=fs.readFileSync(file,'utf8').trim();if(!/^[A-Za-z0-9_-]{43,128}$/.test(value)||value===process.env.JWT_SECRET||value===process.env.ENCRYPTION_KEY)throw Error('A distinct random receipt key is required');return value;}
module.exports={mac,sign,verify,readKey};
