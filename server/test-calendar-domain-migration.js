// Feed addresses may move without replacing class or booking-window identities.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
function render(host) {
  const script = `const c=require('./server/calendar');const {DateTime}=require('./server/node_modules/luxon');const rows=[{event_id:'42',gym_id:'psycle-london',status:'confirmed',start_at:'2099-03-04T10:00:00',duration_min:45,sequence:3,class_name:'Ride',group_name:'Ride'}];console.log(JSON.stringify({links:c.buildLinks('synthetic-token'),ics:c.serializeCalendar(7,rows,{}, {},c.bookingWindowEvents(['psycle-london'],DateTime.fromISO('2099-03-04T10:00:00',{zone:'Europe/London'})))}));`;
  const r=spawnSync(process.execPath,['-e',script],{cwd:require('node:path').join(__dirname,'..'),encoding:'utf8',env:{...process.env,NODE_ENV:'test',DB_PATH:':memory:',ENCRYPTION_KEY:'a'.repeat(64),PUBLIC_HOST:host,CALENDAR_UID_NAMESPACE:'sweat.wingfield.tech'}});
  assert.equal(r.status,0,r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}
const old=render('sweat.wingfield.tech'), moved=render('app.dibs.fit');
const uids=ics=>ics.match(/^UID:.*$/gm);
assert.deepEqual(uids(old.ics),uids(moved.ics));
assert.ok(uids(moved.ics).length>1,'class and booking-window identities covered');
assert.ok(uids(moved.ics).every(uid=>uid.endsWith('@sweat.wingfield.tech')));
assert.match(moved.ics,/SEQUENCE:3/);
assert.match(moved.ics,/https:\/\/app.dibs.fit/);
assert.equal(moved.links.https,'https://app.dibs.fit/api/calendar/synthetic-token.ics');
assert.equal(moved.links.webcal,'webcal://app.dibs.fit/api/calendar/synthetic-token.ics');
assert.ok(moved.links.google.includes('cid=http://app.dibs.fit/'));
console.log('Calendar domain migration: stable class/window UIDs and sequences; new feed links PASS');
