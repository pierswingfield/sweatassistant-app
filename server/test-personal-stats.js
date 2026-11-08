process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'personal-stats-test';
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { DateTime } = require('luxon');
const db = require('./db');
const testkit = require('./testkit');
const history = require('./class-history');
const { getProvider } = require('./providers');
const NOW = Date.parse('2026-11-04T18:00:00Z');
const row = (startAt, eventId, extra = {}) => ({ gymId: 'psycle-london', bookingId: String(eventId), eventId, status: 'unconfirmed', startAt, ...extra });
const agg = (rows, opts = {}) => history.aggregatePersonalHistory(rows, { now: NOW, ...opts });
async function main() {
  const rows = [row('2026-11-02T10:00Z', 'a'), row('2026-11-02T10:00Z', 'a', { bookingId: 'guest' }), row('2026-11-02T10:00Z', 'a', { gymId: 'jab-boxing' }), row('2026-11-03T10:00Z', '', { bookingId: 'empty1' }), row('2026-11-03T10:00Z', '', { bookingId: 'empty2' }), ...['cancelled','late-cancel','no-show','class-cancelled','waitlist'].map(status => row('2026-11-03T10:00Z', status, { status })), row('2026-11-05T10:00Z','future'), row('2026-11-04T17:30Z','running',{ durationMin: 60 })];
  const a = agg(rows);
  assert.equal(a.totalPastClasses, 4); assert.equal(a.volume.points.length, 30); assert.equal(a.volume.points.reduce((n,p)=>n+p.count,0),4);
  assert.equal(a.patterns.hours[10],4); assert.equal(a.patterns.hours.reduce((sum, count) => sum + count, 0),4);
  assert.equal(a.volume.points[0].count,0); assert.equal(a.patterns.gymMix[0].count,3); assert.equal(a.patterns.gymMix[0].percent,75);
  assert.equal(agg([]).streak.weeks,0); assert.equal(agg([]).patterns.gymMix.length,0);
  const consecutive = [0,1,2,3].map(n=>row(DateTime.fromMillis(NOW).startOf('week').minus({weeks:n}).plus({hours:10}).toISO(),`week${n}`));
  assert.equal(agg(consecutive).streak.weeks,4); assert.equal(agg(consecutive.slice(1)).streak.weeks,3,'unfinished current week has grace');
  assert.equal(agg(consecutive.slice(2)).streak.weeks,0,'missed full week breaks streak');
  const years = ['2025-12-22T10:00Z','2025-12-29T10:00Z','2026-01-05T10:00Z'].map((d,i)=>row(d,i));
  assert.equal(agg(years,{now:Date.parse('2026-01-07T18:00Z')}).streak.weeks,3);
  const dst = agg([row('2026-10-25T00:30Z','early',{timeZone:'America/New_York'}),row('2026-10-25T01:30Z','late',{timeZone:'Asia/Tokyo'})],{zone:'Europe/London'});
  assert.equal(dst.volume.points.find(p=>p.date==='2026-10-25').count,2); assert.equal(dst.patterns.weekdays[5],1); assert.equal(dst.patterns.weekdays[6],1); assert.equal(dst.patterns.timeBins[5],1); assert.equal(dst.patterns.timeBins[2],1); assert.equal(dst.patterns.hours[20],1); assert.equal(dst.patterns.hours[10],1); assert.equal(dst.patterns.hours.reduce((a,b)=>a+b,0),2);
  assert.equal(agg([],{zone:'invalid/zone'}).analysisZone,'UTC');
  assert.equal(agg(rows,{coverage:[{gymId:'jab-boxing',state:'failed',limited:false}]}).streak.atLeast,true);
  console.log('PASS pure aggregates: dedupe, outcomes, future/end, zero dates, weekly grace/year, DST/class-local zones, partial coverage');
  const uid=testkit.createUser(db,'personal-owner@test.local','enc:pw');
  const other=testkit.createUser(db,'personal-other@test.local','enc:pw');
  db.linkGym(uid,'jab-boxing',{encryptedPassword:'enc:pw'});
  const many=Array.from({length:1105},(_,i)=>row('2026-11-02T10:00Z',`many-${i}`));
  // A 600-week unbroken streak predates both account creation and the list endpoint's ten-year cap.
  const ancient=Array.from({length:600},(_,i)=>row(DateTime.fromMillis(NOW).startOf('week').minus({weeks:i}).plus({hours:12}).toISO(),`old-${i}`));
  history.upsertEntries(uid,'psycle-london',[...many,...ancient]);
  history.upsertEntries(other,'psycle-london',[row('2026-11-03T10:00Z','secret')]);
  db.setUserGymEnabled(uid,'psycle-london',false); db.setUserGymEnabled(uid,'jab-boxing',false);
  let data=history.personalStats(uid,{now:NOW,refresh:false});
  assert.equal(data.totalPastClasses,1705); assert.equal(data.streak.weeks,600); assert.ok(data.coverage.some(c=>c.state==='disabled')); assert.ok(JSON.stringify(data).length<7000,'bounded response');
  const empty=db.createAccount('personal-empty@test.local','long-test-password');
  assert.equal(history.personalStats(empty,{refresh:false}).totalPastClasses,0);
  // Pure fixture cleanup models unlink and proves the owning query excludes orphan rows immediately.
  db.db.prepare('DELETE FROM user_gyms WHERE user_id=? AND gym_id=?').run(uid,'psycle-london');
  assert.equal(history.personalStats(uid,{now:NOW,refresh:false}).totalPastClasses,0);
  const app=express();app.use('/api',require('./routes-normalized'));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/personal-stats`)).status,401);
    const token=jwt.sign({userId:uid},process.env.JWT_SECRET);
    const res=await fetch(`${base}/api/personal-stats?userId=${other}&gymId=psycle-london`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'private, no-store');const own=await res.json();assert.equal(own.totalPastClasses,0);assert.ok(!JSON.stringify(own).includes('secret'));assert.ok(!('history' in own));
  } finally {await new Promise(r=>server.close(r));}
  console.log('PASS store/endpoint: >1,000 rows, >10 years, pre-account history, linked/account isolation, empty account, unlink, authentication, private bounded payload');
  const provider=getProvider('psycle-london');const original=provider.requestV2;
  provider.requestV2=async()=>({ok:true,json:async()=>({data:[{id:'no-event'}],meta:{last_page:61}})});
  try {let limited;await provider.listBookingHistory({accessToken:'fixture'},{onCoverage:c=>limited=c.limited});assert.equal(limited,true);}finally{provider.requestV2=original;}
  console.log('PASS provider guard explicitly reports bounded import');
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
