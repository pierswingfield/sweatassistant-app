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
    const result = db.prepare('INSERT INTO users (email, encrypted_password) VALUES (?, ?)').run(email, encryptedPassword);
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

  // Auto-bookings
  getPendingAutoBookings() {
    return db.prepare("SELECT * FROM auto_bookings WHERE status = 'pending' AND executed_at IS NULL").all();
  },
  getUserAutoBookings(userId) {
    return db.prepare('SELECT * FROM auto_bookings WHERE user_id = ? ORDER BY id DESC').all(userId);
  },
  addAutoBooking(userId, eventId, className, instructorName, studioName, locationName, startAt, preferences, studioId = null) {
    const result = db.prepare(`
      INSERT INTO auto_bookings (user_id, event_id, studio_id, class_name, instructor_name, studio_name, location_name, start_at, preferences)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, eventId, studioId, className, instructorName, studioName, locationName, startAt, JSON.stringify(preferences));
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
  addAutoUpgrade(userId, eventId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, studioId = null) {
    const result = db.prepare(`
      INSERT INTO auto_upgrades (user_id, event_id, studio_id, booking_id, current_slot_id, class_name, instructor_name, studio_name, location_name, start_at, preferences)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, eventId, studioId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, JSON.stringify(preferences));
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
