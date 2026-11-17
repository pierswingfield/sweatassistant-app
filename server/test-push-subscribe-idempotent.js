// Push subscribe is idempotent per endpoint and a confirmation reaches only the
// device that just subscribed. Regression for "four confirmation pushes in a row":
// duplicate subscribe calls inserted duplicate rows and every row got every push.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'push-sub-secret';
const assert = require('assert');
const webpush = require('web-push');
const db = require('./db');
const testkit = require('./testkit');

const sent = [];
webpush.sendNotification = async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); };
const notifications = require('./notifications');

const rows = (uid) => db.getPushSubscriptions(uid);
const uid = testkit.createUser(db, 'push@example.com', 'x');
const other = testkit.createUser(db, 'push2@example.com', 'x');
const sub = (n, k = 'k') => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: k, auth: 'a' } });

(async () => {
  assert.deepStrictEqual(db.addPushSubscription(uid, sub('A')), { created: true });
  assert.deepStrictEqual(db.addPushSubscription(uid, sub('A')), { created: false }, 'repeat subscribe is not a new row');
  assert.deepStrictEqual(db.addPushSubscription(uid, sub('A', 'k2')), { created: false });
  assert.strictEqual(rows(uid).length, 1, 'one row per endpoint');
  assert.strictEqual(JSON.parse(rows(uid)[0].subscription).keys.p256dh, 'k2', 'repeat refreshes the keys');

  db.addPushSubscription(uid, sub('B'));
  assert.strictEqual(rows(uid).length, 2, 'a second device is a second row');

  // The same endpoint under another account moves, never duplicates.
  assert.deepStrictEqual(db.addPushSubscription(other, sub('A')), { created: true });
  assert.strictEqual(rows(uid).length, 1);
  assert.strictEqual(rows(other).length, 1);

  // Confirmation: only the named device, tagged so repeats collapse.
  await notifications.sendGenericTest(uid, { onlyEndpoint: sub('B').endpoint });
  assert.strictEqual(sent.length, 1, 'exactly one confirmation');
  assert.strictEqual(sent[0].endpoint, sub('B').endpoint);
  assert.strictEqual(sent[0].payload.notification.tag, 'push-confirmation');

  // Boot dedupe collapses legacy duplicates (keeps the newest).
  for (let i = 0; i < 3; i++) db.db.prepare('INSERT INTO push_subscriptions (user_id, subscription) VALUES (?, ?)').run(uid, JSON.stringify(sub('C')));
  assert.strictEqual(db.dedupePushSubscriptions(), 2);
  assert.strictEqual(rows(uid).filter((r) => JSON.parse(r.subscription).endpoint === sub('C').endpoint).length, 1);
  console.log('test-push-subscribe-idempotent: all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
