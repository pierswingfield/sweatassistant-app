process.env.DB_PATH = ':memory:';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const assert = require('assert');
const db = require('./db');
const { createUser } = require('./testkit');
const scheduler = require('./scheduler');
const gate = require('./gym-mutation-gate');
const Provider = require('./providers/codexfit');
const gym = 'psycle-london';
let serial = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(count = 1) {
  const n = ++serial, user = createUser(db, `guest-race-${n}@test.local`, 'enc');
  db.setGymSession(user, gym, { accessToken: 'fixture' });
  const guests = Array.from({length: count}, (_, i) => ({email: `guest${i}@example.test`}));
  const prefs = { requiredCount: count + 1, bookAny: true, guests };
  const event = `race-${n}`;
  const id = db.addAutoBooking(user, event, 'Class', '', '', '', new Date(Date.now()+86400000).toISOString(), prefs, null, null, null, gym);
  const participants = [{participantKey:'self',participantType:'self',guestEmail:null,guestName:null}, ...guests.map(g => ({participantKey:`guest:${g.email}`,participantType:'guest',guestEmail:g.email,guestName:null}))];
  db.replaceAutoBookingParticipants(id, user, gym, event, participants);
  db.markAutoBookingParticipant(id, user, 'self', {status:'success',bookingId:'host',slotId:'1'});
  return { user, id, event, row: db.getUserAutoBookings(user, gym).find(x=>x.id===id), guests };
}
Provider.prototype.fetchEventDetails = async () => ({event:{}, slots:[{id:'1',label:'1',isAvailable:false},{id:'2',label:'2',isAvailable:true},{id:'3',label:'3',isAvailable:true}]});
(async () => {
  {
    const f = fixture();
    const entered = deferred(), resume = deferred();
    Provider.prototype.bookGuestSlot = async () => { gate.beforeRequest(gym,'POST'); entered.resolve(); await resume.promise; return {ok:true,bookingId:'guest-booked',slotId:'2'}; };
    const worker = scheduler.executeAutoBookForClass(f.row);
    await entered.promise;
    let switched = false;
    const off = gate.disable(f.user,gym).then(()=>{switched=true;});
    await Promise.resolve();
    assert.strictEqual(switched,false,'switch must await an in-flight guest write on a resumed row');
    resume.resolve(); await worker; await off;
    const guest = db.getAutoBookingParticipants(f.id,f.user).find(x=>x.participant_type==='guest');
    assert.strictEqual(guest.status,'success');
  }
  {
    const f = fixture(); let off, writes = 0;
    Provider.prototype.bookGuestSlot = async () => { off = gate.disable(f.user,gym); gate.beforeRequest(gym,'POST'); writes++; };
    await scheduler.executeAutoBookForClass(f.row); await off;
    const guest = db.getAutoBookingParticipants(f.id,f.user).find(x=>x.participant_type==='guest');
    assert.strictEqual(writes,0);
    assert.strictEqual(guest.status,'pending','guest remains pending when switch interrupts provider preparation');
    assert.strictEqual(guest.attempted_at,null);
    assert.strictEqual(db.getUserAutoBookings(f.user,gym).find(x=>x.id===f.id).status,'pending');
  }
  {
    // Older/imported rows can contain more than one named guest.
    const f = fixture(2); let off, writes = 0;
    Provider.prototype.bookGuestSlot = async () => {
      gate.beforeRequest(gym,'POST'); writes++;
      off = gate.disable(f.user,gym);
      return {ok:true,bookingId:'first-guest',slotId:'2'};
    };
    await scheduler.executeAutoBookForClass(f.row); await off;
    const guests = db.getAutoBookingParticipants(f.id,f.user).filter(x=>x.participant_type==='guest');
    assert.strictEqual(writes,1,'a later guest does not start after disabling');
    assert.deepStrictEqual(guests.map(x=>x.status),['success','pending']);
    assert.strictEqual(guests[1].attempted_at,null);
    assert.strictEqual(db.getUserAutoBookings(f.user,gym).find(x=>x.id===f.id).status,'pending');
  }
  {
    const f = fixture(); let off;
    Provider.prototype.fetchEventDetails = async () => ({event:{}, slots:[{id:'1',isAvailable:false},{id:'2',isAvailable:true}]});
    Provider.prototype.bookGuestSlot = async () => { gate.beforeRequest(gym,'POST'); off = gate.disable(f.user,gym); return {ok:false,code:'SPOT_UNAVAILABLE'}; };
    await scheduler.executeAutoBookForClass(f.row); await off;
    const guest = db.getAutoBookingParticipants(f.id,f.user).find(x=>x.participant_type==='guest');
    assert.strictEqual(guest.status,'pending','an interrupted search remains pending after the last candidate is taken');
    assert.strictEqual(db.getUserAutoBookings(f.user,gym).find(x=>x.id===f.id).status,'pending');
  }
  console.log('Guest switch races passed');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
