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
  data={results:[]}; mt._reservationClassEvents=async()=>new Map();
  assert.deepEqual(await mt.listBookings({}),[],'native MarianaTek list behavior is retained');
  assert.equal((await mt.listBookingSnapshot({})).complete,false,'unknown metadata is never complete');
  console.log('PASS booking snapshot: actual adapters reject missing, truncated and inconsistent proofs');
})().catch(e=>{console.error('FAIL booking snapshot:',e.message);process.exitCode=1});
