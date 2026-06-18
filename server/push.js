const webpush = require('web-push');
const db = require('./db');

function initWebPush() {
  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || 'mailto:admin@psycle.wingfield.tech';

  if (!publicKey || !privateKey) {
    publicKey = db.getKV('vapid_public_key');
    privateKey = db.getKV('vapid_private_key');

    if (!publicKey || !privateKey) {
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;
      db.setKV('vapid_public_key', publicKey);
      db.setKV('vapid_private_key', privateKey);
      console.log('[Push] Automatically generated and saved VAPID keypair in server database.');
    }
  }

  webpush.setVapidDetails(email, publicKey, privateKey);
  return publicKey;
}

const vapidPublicKey = initWebPush();

async function sendNotification(userId, title, body, data = {}) {
  const subscriptions = db.getPushSubscriptions(userId);
  if (subscriptions.length === 0) {
    console.log(`[Push] No push subscriptions found for user ${userId}. Skipping notification.`);
    return;
  }

  const payload = JSON.stringify({
    notification: {
      title,
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data
    }
  });

  console.log(`[Push] Attempting to send push notification to ${subscriptions.length} clients for user ${userId}...`);

  const promises = subscriptions.map(async (subRow) => {
    try {
      const subscription = JSON.parse(subRow.subscription);
      await webpush.sendNotification(subscription, payload);
    } catch (err) {
      // 404 (Not Found) or 410 (Gone) indicates the subscription has expired or been revoked
      if (err.statusCode === 410 || err.statusCode === 404) {
        try {
          const sub = JSON.parse(subRow.subscription);
          db.deletePushSubscription(userId, sub.endpoint);
          console.log('[Push] Revoked subscription deleted successfully.');
        } catch (dbErr) {
          console.error('[Push] Error deleting expired subscription:', dbErr);
        }
      } else {
        console.error('[Push] Error sending web push notification:', err);
      }
    }
  });

  await Promise.allSettled(promises);
}

module.exports = {
  vapidPublicKey,
  sendNotification
};
