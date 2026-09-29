// Admin detail must consume normalized provider bookings and metadata for the
// selected gym, including MarianaTek's embedded class shape.
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.ADMIN_PASSWORD = 'admin-test-password';

const assert = require('assert');
const express = require('express');
const db = require('./db');
const { getProvider } = require('./providers');
const admin = require('./admin');

(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', admin);
  const server = app.listen(0);
  try {
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/admin`;
    const login = await fetch(`${base}/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: process.env.ADMIN_PASSWORD }),
    });
    const { token } = await login.json();
    assert.ok(token, 'admin login returns a token');

    db.db.prepare('UPDATE gyms SET enabled = 1 WHERE id = ?').run('jab-boxing');
    const userId = db.createAccount(`admin-mt-${Date.now()}@test.local`, 'password123');
    db.linkGym(userId, 'jab-boxing', { encryptedPassword: 'enc:pw' });
    db.setGymSession(userId, 'jab-boxing', { accessToken: 'jab-token', expiresAt: '2099-01-01T00:00:00Z' });

    const provider = getProvider('jab-boxing');
    const originals = { listBookings: provider.listBookings, fetchMetadata: provider.fetchMetadata, request: provider.request };
    let listedWith;
    provider.listBookings = async (session) => {
      listedWith = session.accessToken;
      return [{
        bookingId: 'mt-booking-1', eventId: 'mt-event-1', slotId: 'spot-24', isWaitlist: false,
        event: {
          startAt: '2099-01-02T12:00:00Z', name: 'JAB Boxing', discipline: 'BOXING',
          instructors: [{ name: 'Coach' }], studioId: 'mt-studio-1', studioName: 'Mariana Room',
          locationName: 'JAB London',
        },
      }];
    };
    provider.fetchMetadata = async (params, session) => {
      assert.strictEqual(session.accessToken, 'jab-token');
      return { studios: [{ id: 'mt-studio-1', name: 'Mariana Room' }] };
    };
    // Make the old raw-path implementation deterministic: it receives a
    // successful but MarianaTek-shaped payload that its CodexFit parser cannot use.
    provider.request = async (pathName) => ({
      ok: true,
      json: async () => pathName === '/bookings?limit=100&page=1'
        ? { results: [{ id: 'mt-booking-1', class_session: { id: 'mt-event-1' } }] }
        : { results: [] },
    });
    try {
      const response = await fetch(`${base}/users/${userId}?gymId=jab-boxing`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.strictEqual(response.status, 200);
      const body = await response.json();
      assert.strictEqual(listedWith, 'jab-token', 'selected gym session is passed to provider listBookings');
      assert.strictEqual(body.bookings[0]?.booking_id, 'mt-booking-1');
      assert.strictEqual(body.bookings[0]?.class_name, 'JAB Boxing');
      assert.strictEqual(body.bookings[0]?.slot_label, 'spot-24');
      assert.strictEqual(body.studioNames['mt-studio-1'], 'Mariana Room');
      assert.strictEqual(body.viewedGymId, 'jab-boxing');
      console.log('🎉 Admin detail reads normalized MarianaTek bookings and per-gym studio metadata.');
    } finally {
      provider.listBookings = originals.listBookings;
      provider.fetchMetadata = originals.fetchMetadata;
      provider.request = originals.request;
    }
  } catch (err) {
    console.error('❌ Admin provider-shapes regression FAILED:\n', err.stack || err.message);
    process.exitCode = 1;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})();
