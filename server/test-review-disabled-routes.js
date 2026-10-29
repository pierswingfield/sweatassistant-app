process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.JWT_SECRET = 'review-route-secret';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disabled-routes-'));
process.env.DB_PATH = path.join(dir, 'app.db');
const db = require('./db');
const user = require('./testkit').createUser(db, 'routes@test.local', 'enc');
const other = require('./testkit').createUser(db, 'other@test.local', 'enc');
const gym = 'psycle-london';
const book = db.db.prepare("INSERT INTO auto_bookings(user_id,gym_id,event_id,preferences) VALUES(?,?,?,'{}')").run(user,gym,123).lastInsertRowid;
const upgrade = db.db.prepare("INSERT INTO auto_upgrades(user_id,gym_id,event_id,booking_id,current_slot_id,preferences) VALUES(?,?,?,?,?,'{}')").run(user,gym,123,12,1).lastInsertRowid;
db.setUserGymEnabled(user, gym, false);
const port = 19000 + process.pid % 10000;
const child = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), NODE_ENV: 'test' }, stdio: 'ignore' });
(async () => {
  const base = `http://127.0.0.1:${port}`;
  for (let i=0;i<100;i++) { try { if ((await fetch(base+'/api/config')).ok) break; } catch (_) {} await new Promise(r=>setTimeout(r,50)); }
  for (const [type,id] of [['auto-book',book], ['auto-upgrade',upgrade]]) {
    for (const method of ['PUT','DELETE']) {
      for (const [uid,status] of [[user,409],[other,404]]) {
        const token = jwt.sign({ userId: uid, email: 'fixture@test.local' }, process.env.JWT_SECRET);
        const res = await fetch(`${base}/api/${type}/${id}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(method === 'PUT' ? {body: JSON.stringify({ preferences: {} })} : {}) });
        assert.strictEqual(res.status,status,`${method} ${type} account ${uid}`);
      }
    }
  }
  assert(db.db.prepare('SELECT 1 FROM auto_bookings WHERE id=?').get(book));
  assert(db.db.prepare('SELECT 1 FROM auto_upgrades WHERE id=?').get(upgrade));
  console.log('Disabled owning-gym mutation routes and account isolation passed');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>{child.kill();db.db.close();fs.rmSync(dir,{recursive:true,force:true});});
