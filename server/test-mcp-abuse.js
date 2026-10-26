global.fetch=async()=>{throw Error('Network forbidden')};
const assert=require('node:assert/strict'),{clientIP,createGuard}=require('./mcp/abuse');
const req={socket:{remoteAddress:'::ffff:10.0.0.2'},headers:{'cf-connecting-ip':'1.2.3.4','x-forwarded-for':'5.6.7.8'}};
assert.equal(clientIP(req),'10.0.0.2');assert.equal(clientIP(req,['10.0.0.2']),'1.2.3.4');
req.headers['cf-connecting-ip']='1.2.3.4, 5.6.7.8';assert.equal(clientIP(req,['10.0.0.2']),'10.0.0.2');
let now=0;const guard=createGuard({clock:()=>now,maxEntries:4,threshold:2,windowMs:100,baseBanMs:200,maxBanMs:1000});
assert.equal(guard.failure('ip','bad-a'),0);assert.equal(guard.failure('ip','bad-b'),1);assert.ok(guard.cached('bad-a'));
now=201;assert.equal(guard.banned('ip'),0);assert.equal(guard.cached('bad-a'),false);
for(let n=0;n<20;n++)guard.failure(`ip-${n}`,`bad-${n}`);
assert.ok(guard.size().ips<=4&&guard.size().tokens<=4);
console.log('PASS MCP abuse: trusted CF peer only, XFF spoof rejected, bounded expiring bans/caches');

const {configuration}=require('./mcp/config');
const env={MCP_ENABLED:'true',MCP_RESOURCE_URL:'https://fixture.example/mcp',MCP_ISSUER:'https://fixture.example/',MCP_JWKS_FILE:'fixture'};
assert.equal(configuration(env).abuseProtection,true);
assert.equal(configuration({...env,MCP_ABUSE_PROTECTION_ENABLED:'false'}).abuseProtection,false);
const plan=require('../scripts/mcp-edge-plan').buildPlan('sweat-mcp-stage.wingfield.tech');
assert.deepEqual(plan.rateLimitingRules,[]);assert.ok(plan.customRules.every(r=>r.enabled===false));
assert.throws(()=>require('../scripts/mcp-edge-plan').buildPlan('bad"host'));
