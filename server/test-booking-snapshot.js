// Snapshot completeness contract; actual adapter parsing, no network.
global.fetch = async () => { throw Error('Unexpected network'); };
process.env.ENCRYPTION_KEY = 'b'.repeat(64);
const assert = require('node:assert/strict');
const CodexFit = require('./providers/codexfit');
const MarianaTek = require('./providers/marianatek');
const res = data => ({ ok:true, json:async()=>data });
(async()=>{
  const codex=Object.create(CodexFit.prototype);
  let data=[]; codex.request=async()=>res(data);
  assert.deepEqual(await codex.listBookings({}),[],'native Codex bare-list behavior is retained');
  assert.equal((await codex.listBookingSnapshot({})).complete,false,'bare page, including empty, proves no completeness');
  data={data:[],meta:{current_page:1,last_page:2,per_page:100,total:101}};
  assert.equal((await codex.listBookingSnapshot({})).complete,false,'another Codex page can contain the active target');
  data={data:[],meta:{current_page:1,last_page:1,per_page:100,total:0}};
  assert.equal((await codex.listBookingSnapshot({})).complete,true,'consistent explicit complete empty envelope is authoritative');
  data={data:[],meta:{current_page:1,last_page:1,per_page:100,total:1}};
  assert.equal((await codex.listBookingSnapshot({})).complete,false,'inconsistent count cannot prove absence');
  const mt=Object.create(MarianaTek.prototype); mt.request=async()=>res(data);
  data={results:[],next:'untrusted-next-page',count:101};
  assert.equal((await mt.listBookingSnapshot({})).complete,false,'active target may be omitted from first MarianaTek page');
  data={results:[],next:null,count:0};
  assert.equal((await mt.listBookingSnapshot({})).complete,true,'explicit next=null plus exact total proves empty snapshot');
  // Sanitized live JAB upcoming response, 2026-10-26: no flat count/next.
  data={results:[],meta:{pagination:{page:1,pages:1,count:0}},links:{first:'first',last:'last',next:null,prev:null}};
  assert.equal((await mt.listBookingSnapshot({})).complete,true,'live nested single-page proof is authoritative');
  mt._reservationClassEvents=async()=>new Map();
  assert.equal((await mt.listBookings({}, {asSnapshot:true})).complete,true,'MCP/PWA read uses the same nested proof');
  for (const pagination of [{page:1,pages:2,count:0},{page:2,pages:2,count:0},{page:1,pages:1,count:1},
    {page:'1',pages:1,count:0},{page:1,pages:'1',count:0},{page:1,pages:1,count:'0'},{page:1,pages:0,count:0},{}]) {
    data={results:[],meta:{pagination},links:{next:null}};
    assert.equal((await mt.listBookingSnapshot({})).complete,false,'missing, inconsistent or coerced nested metadata is rejected');
  }
  for (const links of [{next:'untrusted-next-page'}, {}, null]) {
    data={results:[],meta:{pagination:{page:1,pages:1,count:0}},links};
    assert.equal((await mt.listBookingSnapshot({})).complete,false,'nested proof requires explicit next=null');
  }
  for (const flat of [{next:'untrusted-next-page',count:0},{next:null,count:1},{count:0}]) {
    data={results:[],meta:{pagination:{page:1,pages:1,count:0}},links:{next:null},...flat};
    assert.equal((await mt.listBookingSnapshot({})).complete,false,'a nested proof cannot override contradictory flat metadata');
  }
  data={results:[],next:null,count:0,meta:{pagination:{page:1,pages:2,count:0}},links:{next:null}};
  assert.equal((await mt.listBookingSnapshot({})).complete,false,'a flat proof cannot override contradictory nested metadata');
  data={results:[]}; mt._reservationClassEvents=async()=>new Map();
  assert.deepEqual(await mt.listBookings({}),[],'native MarianaTek list behavior is retained');
  assert.equal((await mt.listBookingSnapshot({})).complete,false,'unknown metadata is never complete');
  console.log('PASS booking snapshot: actual adapters reject missing, truncated and inconsistent proofs');
})().catch(e=>{console.error('FAIL booking snapshot:',e.message);process.exitCode=1});
