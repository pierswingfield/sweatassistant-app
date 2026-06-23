const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'sqlite.db');

// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    encrypted_password TEXT NOT NULL,
    jwt TEXT,
    jwt_expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auto_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    class_name TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    start_at TEXT,
    preferences TEXT NOT NULL, -- JSON string
    status TEXT DEFAULT 'pending', -- pending, success, failed, waitlist
    execution_message TEXT,
    executed_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS auto_upgrades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    booking_id INTEGER NOT NULL,
    current_slot_id INTEGER NOT NULL,
    class_name TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    start_at TEXT,
    preferences TEXT NOT NULL, -- JSON string (preferredSlots, keepOriginalOnCutoff)
    status TEXT DEFAULT 'active', -- active, upgraded, stopped, paused_no_credits, cutoff_booked
    status_message TEXT,
    upgraded_slot_id INTEGER,
    upgraded_at TEXT,
    new_booking_id INTEGER,
    last_checked_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS studio_preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    preferences TEXT NOT NULL, -- JSON string
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, studio_id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    preferences TEXT NOT NULL, -- JSON string
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subscription TEXT NOT NULL, -- JSON string
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS server_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Cached snapshot of a user's upcoming bookings, used to fire cancellation
  -- reminders locally without hammering the CodexFit API. Populated by client
  -- sync (free), the proxy booking hook, and an infrequent discovery poll.
  CREATE TABLE IF NOT EXISTS booking_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    booking_id INTEGER NOT NULL,
    event_id INTEGER,
    start_at TEXT,
    class_name TEXT,
    group_name TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    slot_label TEXT,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, booking_id)
  );

  -- Dedupe ledger for one-shot scheduled notifications (cancellation + booking-window reminders).
  CREATE TABLE IF NOT EXISTS sent_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, dedupe_key)
  );
`);

// --- Lightweight migrations ---
// Add studio_id to auto_bookings / auto_upgrades so execution can resolve the
// live shared studio spot map (single source of truth) rather than a snapshot.
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('auto_bookings', 'studio_id', 'INTEGER');
ensureColumn('auto_upgrades', 'studio_id', 'INTEGER');
// Store the event-type group (e.g. "RIDE") so notifications can render it without a re-fetch.
ensureColumn('auto_bookings', 'group_name', 'TEXT');
ensureColumn('auto_upgrades', 'group_name', 'TEXT');
// User priority for contested-slot ordering: lower number = higher priority (default 100 = standard).
// Set to a lower value (e.g. 10) to elevate a user above others in the same release window.
ensureColumn('users', 'priority', 'INTEGER DEFAULT 100');
// Display name cached from CodexFit profile on first login; shown in admin panel.
ensureColumn('users', 'display_name', 'TEXT');

// Helper methods
module.exports = {
  // Direct access if needed
  db,

  // Key-value store
  getKV(key) {
    const row = db.prepare('SELECT value FROM server_kv WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  setKV(key, value) {
    db.prepare('INSERT OR REPLACE INTO server_kv (key, value) VALUES (?, ?)').run(key, value);
  },

  // User management
  getUserByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },
  getUserById(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  },
  createUser(email, encryptedPassword) {
    // All new users share priority 200 — one fixed tier below the founding users (100).
    // Admins can promote individuals via the admin panel; new signups always start here.
    const result = db.prepare('INSERT INTO users (email, encrypted_password, priority) VALUES (?, ?, 200)').run(email, encryptedPassword);
    return result.lastInsertRowid;
  },
  updateUserCredentials(userId, encryptedPassword, jwt, jwtExpiresAt) {
    db.prepare('UPDATE users SET encrypted_password = ?, jwt = ?, jwt_expires_at = ? WHERE id = ?')
      .run(encryptedPassword, jwt, jwtExpiresAt, userId);
  },
  updateUserJWT(userId, jwt, jwtExpiresAt) {
    db.prepare('UPDATE users SET jwt = ?, jwt_expires_at = ? WHERE id = ?')
      .run(jwt, jwtExpiresAt, userId);
  },
  updateUserDisplayName(userId, displayName) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
  },

  // Auto-bookings
  getPendingAutoBookings() {
    // JOIN users to include priority so the scheduler can tier-sort + shuffle within tier.
    // Lower priority value = higher precedence (default 100; set to e.g. 10 for VIPs).
    return db.prepare(`
      SELECT ab.*, u.priority
      FROM auto_bookings ab
      JOIN users u ON u.id = ab.user_id
      WHERE ab.status = 'pending' AND ab.executed_at IS NULL
      ORDER BY u.priority ASC, ab.created_at ASC
    `).all();
  },
  getUserAutoBookings(userId) {
    return db.prepare('SELECT * FROM auto_bookings WHERE user_id = ? ORDER BY id DESC').all(userId);
  },
  countPendingAutoBookings(userId) {
    return db.prepare("SELECT COUNT(*) AS n FROM auto_bookings WHERE user_id = ? AND status = 'pending' AND executed_at IS NULL").get(userId).n;
  },
  addAutoBooking(userId, eventId, className, instructorName, studioName, locationName, startAt, preferences, studioId = null, groupName = null) {
    const result = db.prepare(`
      INSERT INTO auto_bookings (user_id, event_id, studio_id, class_name, instructor_name, studio_name, location_name, start_at, preferences, group_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, eventId, studioId, className, instructorName, studioName, locationName, startAt, JSON.stringify(preferences), groupName);
    return result.lastInsertRowid;
  },
  updateAutoBookingPreferences(id, userId, preferences) {
    db.prepare('UPDATE auto_bookings SET preferences = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(preferences), id, userId);
  },
  deleteAutoBooking(id, userId) {
    db.prepare('DELETE FROM auto_bookings WHERE id = ? AND user_id = ?').run(id, userId);
  },
  markAutoBookingExecuted(eventId, userId, status, message, executedAt, statusUpdates = {}) {
    db.prepare(`
      UPDATE auto_bookings 
      SET status = ?, execution_message = ?, executed_at = ? 
      WHERE event_id = ? AND user_id = ? AND executed_at IS NULL
    `).run(status, message, executedAt, eventId, userId);
  },

  // Auto-upgrades
  getActiveAutoUpgrades() {
    return db.prepare("SELECT * FROM auto_upgrades WHERE status = 'active'").all();
  },
  getUserAutoUpgrades(userId) {
    return db.prepare('SELECT * FROM auto_upgrades WHERE user_id = ? ORDER BY id DESC').all(userId);
  },
  countActiveAutoUpgrades(userId) {
    return db.prepare("SELECT COUNT(*) AS n FROM auto_upgrades WHERE user_id = ? AND status = 'active'").get(userId).n;
  },
  addAutoUpgrade(userId, eventId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, studioId = null, groupName = null) {
    const result = db.prepare(`
      INSERT INTO auto_upgrades (user_id, event_id, studio_id, booking_id, current_slot_id, class_name, instructor_name, studio_name, location_name, start_at, preferences, group_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, eventId, studioId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, JSON.stringify(preferences), groupName);
    return result.lastInsertRowid;
  },
  updateAutoUpgrade(id, userId, status, statusMessage, updates = {}) {
    const setClause = [];
    const params = [status, statusMessage];

    if (updates.currentSlotId !== undefined) {
      setClause.push('current_slot_id = ?');
      params.push(updates.currentSlotId);
    }
    if (updates.upgradedSlotId !== undefined) {
      setClause.push('upgraded_slot_id = ?');
      params.push(updates.upgradedSlotId);
    }
    if (updates.upgradedAt !== undefined) {
      setClause.push('upgraded_at = ?');
      params.push(updates.upgradedAt);
    }
    if (updates.newBookingId !== undefined) {
      setClause.push('new_booking_id = ?');
      params.push(updates.newBookingId);
    }
    if (updates.lastCheckedAt !== undefined) {
      setClause.push('last_checked_at = ?');
      params.push(updates.lastCheckedAt);
    }
    if (updates.preferences !== undefined) {
      setClause.push('preferences = ?');
      params.push(JSON.stringify(updates.preferences));
    }

    const setStr = setClause.length > 0 ? ', ' + setClause.join(', ') : '';
    db.prepare(`UPDATE auto_upgrades SET status = ?, status_message = ? ${setStr} WHERE id = ? AND user_id = ?`)
      .run(...params, id, userId);
  },
  deleteAutoUpgrade(id, userId) {
    db.prepare('DELETE FROM auto_upgrades WHERE id = ? AND user_id = ?').run(id, userId);
  },

  // Studio Preferences
  getStudioPreferences(userId) {
    return db.prepare('SELECT * FROM studio_preferences WHERE user_id = ?').all(userId);
  },
  // Resolve a single studio's live preferred spot map (the shared source of truth)
  getStudioPreference(userId, studioId) {
    if (studioId == null) return null;
    const row = db.prepare('SELECT preferences FROM studio_preferences WHERE user_id = ? AND studio_id = ?').get(userId, studioId);
    return row ? JSON.parse(row.preferences) : null;
  },
  setStudioPreference(userId, studioId, preferences) {
    db.prepare(`
      INSERT INTO studio_preferences (user_id, studio_id, preferences, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, studio_id) DO UPDATE SET preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
    `).run(userId, studioId, JSON.stringify(preferences));
  },

  // Settings
  getUserSettings(userId) {
    const row = db.prepare('SELECT preferences FROM settings WHERE user_id = ?').get(userId);
    return row ? JSON.parse(row.preferences) : null;
  },
  setUserSettings(userId, preferences) {
    db.prepare(`
      INSERT INTO settings (user_id, preferences, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
    `).run(userId, JSON.stringify(preferences));
  },

  // Push Subscriptions
  getPushSubscriptions(userId) {
    return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  },
  deleteAllUserData(userId) {
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  },

  // User lookups (for background notification jobs)
  getAllUserIds() {
    return db.prepare('SELECT id FROM users').all().map(r => r.id);
  },
  getUserIdsWithPushSubs() {
    return db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all().map(r => r.user_id);
  },

  // Booking cache (for cancellation reminders — no per-minute API polling)
  replaceBookingCache(userId, bookings) {
    const del = db.prepare('DELETE FROM booking_cache WHERE user_id = ?');
    const ins = db.prepare(`
      INSERT OR REPLACE INTO booking_cache
        (user_id, booking_id, event_id, start_at, class_name, group_name, instructor_name, studio_name, location_name, slot_label, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const tx = db.transaction((uid, list) => {
      del.run(uid);
      for (const b of list) {
        if (b.bookingId == null || !b.startAt) continue;
        ins.run(uid, b.bookingId, b.eventId ?? null, b.startAt, b.className ?? null, b.groupName ?? null,
          b.instructorName ?? null, b.studioName ?? null, b.locationName ?? null, String(b.slotLabel ?? ''));
      }
    });
    tx(userId, Array.isArray(bookings) ? bookings : []);
  },
  getAllBookingCache() {
    return db.prepare('SELECT * FROM booking_cache').all();
  },
  getBookingCacheForUser(userId) {
    return db.prepare('SELECT * FROM booking_cache WHERE user_id = ?').all(userId);
  },
  pruneBookingCache(beforeISO) {
    db.prepare('DELETE FROM booking_cache WHERE start_at < ?').run(beforeISO);
  },

  // Sent-notification dedupe ledger (one-shot scheduled reminders)
  wasNotificationSent(userId, key) {
    return !!db.prepare('SELECT 1 FROM sent_notifications WHERE user_id = ? AND dedupe_key = ?').get(userId, key);
  },
  markNotificationSent(userId, key) {
    db.prepare('INSERT OR IGNORE INTO sent_notifications (user_id, dedupe_key) VALUES (?, ?)').run(userId, key);
  },
  pruneSentNotifications(beforeISO) {
    db.prepare('DELETE FROM sent_notifications WHERE sent_at < ?').run(beforeISO);
  },

  // Admin queries
  getAllUsers() {
    return db.prepare(`
      SELECT
        u.id, u.email, u.display_name, u.priority, u.created_at, u.jwt_expires_at,
        (SELECT COUNT(*) FROM auto_bookings WHERE user_id = u.id AND status = 'pending' AND executed_at IS NULL) AS pending_bookings,
        (SELECT COUNT(*) FROM auto_upgrades WHERE user_id = u.id AND status = 'active') AS active_upgrades
      FROM users u
      ORDER BY u.priority ASC, u.created_at ASC
    `).all();
  },
  setUserPriority(userId, priority) {
    db.prepare('UPDATE users SET priority = ? WHERE id = ?').run(priority, userId);
  },
  deleteUser(userId) {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  },

  addPushSubscription(userId, subscription) {
    db.prepare('INSERT INTO push_subscriptions (user_id, subscription) VALUES (?, ?)')
      .run(userId, JSON.stringify(subscription));
  },
  deletePushSubscription(userId, endpoint) {
    // We need to parse JSON subscriptions to compare endpoints, or just match endpoints in subscription string
    db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND subscription LIKE ?")
      .run(userId, `%${endpoint}%`);
  }
};
