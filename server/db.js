const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { DEFAULT_GYM_ID } = require('./gyms.config');

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
    status TEXT DEFAULT 'active', -- active, upgraded, stopped, paused_no_credits, paused_disabled, cutoff_booked
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

  -- Account-scoped settings (WP-D6). The "settings" table above is per-GYM; this
  -- holds the keys that belong to the person rather than to any one gym, so a
  -- gym switch does not reset your notification preferences. See
  -- ACCOUNT_SCOPED_SETTING_KEYS in this file for what lives here, and why the
  -- split defaults the OTHER way. (No backticks in here: this whole schema is a
  -- JS template literal.)
  CREATE TABLE IF NOT EXISTS account_settings (
    user_id INTEGER PRIMARY KEY,
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

  -- A guest reservation is provider-side independent, but it is not an
  -- independent booking in the product: JAB requires it to travel with the
  -- member's reservation. Keep that relationship durable so every cancel
  -- surface can remove the guest first and never orphan it.
  CREATE TABLE IF NOT EXISTS guest_booking_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gym_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    primary_booking_id TEXT NOT NULL,
    guest_booking_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id, guest_booking_id)
  );

  -- F-10-0: minimal per-user CLASS HISTORY (past bookings), shaped so C8-1's
  -- booking_ledger can adopt it. One row per (user, gym, provider booking id), NORMALIZED
  -- fields only. Written ONLY through server/class-history.js. start_ts (epoch ms)
  -- exists because ISO strings with differing zone offsets do not sort lexically.
  CREATE TABLE IF NOT EXISTS class_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gym_id TEXT NOT NULL,
    booking_id TEXT NOT NULL,
    event_id TEXT,
    status TEXT NOT NULL,
    start_at TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    time_zone TEXT,
    duration_min INTEGER,
    class_name TEXT,
    discipline TEXT,
    instructor_id TEXT,
    instructor_name TEXT,
    studio_id TEXT,
    studio_name TEXT,
    location_id TEXT,
    location_name TEXT,
    slot_label TEXT,
    spot_section TEXT,
    fetched_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id, booking_id)
  );
  CREATE INDEX IF NOT EXISTS idx_class_history_user_gym_ts ON class_history(user_id, gym_id, start_ts);

  -- F-10-0: when each (user, gym) history was last pulled, and how it went.
  CREATE TABLE IF NOT EXISTS class_history_sync (
    user_id INTEGER NOT NULL,
    gym_id TEXT NOT NULL,
    last_synced_at TEXT,
    last_attempt_at TEXT,
    last_error TEXT,
    row_count INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, gym_id)
  );

  -- F-12: gym-neutral FAVOURITES for gyms with no native bookmarks. A favourite is a
  -- recurring slot (studio + weekday + start time in the class's zone), the same shape as
  -- CodexFit's native bookmark key so one API serves both. studio_id is a PROVIDER id,
  -- unique only inside a gym; gym_id is NOT NULL with no default on purpose (WP-D6).
  -- Label columns are display-only; a later Auto-Book rule (C5-2) may add discipline/instructor
  -- MATCHING columns without touching the unique slot key.
  CREATE TABLE IF NOT EXISTS favourites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gym_id TEXT NOT NULL,
    studio_id TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    start_time TEXT NOT NULL,
    class_name TEXT,
    discipline TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id, studio_id, day_of_week, start_time)
  );

  -- C7-3: durable record of administrative actions. Never holds secrets (see recordAdminAudit).
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    actor TEXT NOT NULL DEFAULT 'admin',
    action TEXT NOT NULL,
    target_user_id INTEGER,
    ip TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_admin_audit_ts ON admin_audit_log(id DESC);

  -- Dedupe ledger for one-shot scheduled notifications (cancellation + booking-window reminders).
  CREATE TABLE IF NOT EXISTS sent_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    dedupe_key TEXT NOT NULL,
    sent_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, dedupe_key)
  );

  -- Cached snapshot of a user's waitlisted classes, refreshed by the calendar poll.
  -- Mirrors booking_cache; one row per waitlisted class (event).
  CREATE TABLE IF NOT EXISTS waitlist_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    start_at TEXT,
    class_name TEXT,
    group_name TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    studio_id INTEGER,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, event_id)
  );

  -- Persistent per-user class store that backs the calendar feed. UPSERTed from
  -- live data (booking_cache + waitlist_cache + auto_bookings) on every snapshot
  -- regeneration. Retains past confirmed classes as history (capped per user).
  CREATE TABLE IF NOT EXISTS calendar_classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    start_at TEXT,
    duration_min INTEGER,
    class_name TEXT,
    group_name TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    slot_label TEXT,           -- confirmed seats, comma-joined (e.g. "3, 4")
    original_slot_label TEXT,  -- first seat ever seen confirmed (for "originally bike 40")
    status TEXT,               -- confirmed | autobook | waitlist
    upgrade_note TEXT,         -- e.g. "Auto-Upgrade is enabled -- originally bike 40"
    sequence INTEGER DEFAULT 0,
    content_hash TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, event_id)
  );

  -- Pre-built per-user ICS feed (the "publish" target). Served verbatim by the feed endpoint.
  CREATE TABLE IF NOT EXISTS calendar_snapshots (
    user_id INTEGER PRIMARY KEY,
    ics TEXT,
    etag TEXT,
    class_count INTEGER DEFAULT 0,
    generated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- ─── Modular multi-gym support (Documentation/Archive/2026-09-26/Backlog/modular-gyms/) ────────
  -- Mirror of server/gyms.config.js, kept in sync by syncGymsFromConfig() below.
  -- The config file is the authoritative source; this table exists for referential
  -- integrity (FK from user_gyms) and so the admin panel can list/join on it without
  -- importing the config module.
  CREATE TABLE IF NOT EXISTS gyms (
    id TEXT PRIMARY KEY,           -- e.g. "psycle-london", "jab-boxing"
    name TEXT NOT NULL,
    provider TEXT NOT NULL,        -- "codexfit" | "marianatek"
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- One row per (account, gym) the account has linked. A Sweat Assistant account
  -- (the users row) can link multiple gyms -- see PLAN.md D1 (multiple gyms per
  -- account). Per-gym credentials/session live here, NOT on users.
  --
  -- NOTE (WP-D1 scope): this table is populated by an idempotent backfill migration
  -- below, but application code does not read/write it yet -- users.jwt etc. remain
  -- authoritative until WP-D3 (account bootstrap + gym linking) and WP-D4 (db.js CRUD
  -- + admin gym-awareness) land. This keeps the migration additive and risk-free: it
  -- can run against production data with zero behavior change.
  CREATE TABLE IF NOT EXISTS user_gyms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    gym_id TEXT NOT NULL,
    encrypted_password TEXT,
    session_json TEXT,             -- JSON AuthSession: {accessToken, refreshToken?, expiresAt?, meta?}
    display_name TEXT,
    profile_json TEXT,
    profile_synced_at TEXT,
    calendar_token TEXT UNIQUE,
    priority INTEGER DEFAULT 100,
    status TEXT DEFAULT 'active',  -- active | needs_relogin | disabled
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id)
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
// C6-4: background relogin health, per (user, gym) link. `relogin_failures` counts
// consecutive failed renewals of any kind (outage or rejection) for the admin;
// `relogin_rejections` counts only consecutive CREDENTIAL rejections and is what
// suspends retrying; both reset on a successful renewal or a re-link.
ensureColumn('user_gyms', 'relogin_failures', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('user_gyms', 'relogin_rejections', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('user_gyms', 'relogin_suspended', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('user_gyms', 'last_relogin_failure_at', 'TEXT');
ensureColumn('user_gyms', 'last_relogin_error', 'TEXT');
ensureColumn('auto_bookings', 'studio_id', 'INTEGER');
ensureColumn('auto_upgrades', 'studio_id', 'INTEGER');
// Store the event-type group (e.g. "RIDE") so notifications can render it without a re-fetch.
ensureColumn('auto_bookings', 'group_name', 'TEXT');
ensureColumn('auto_upgrades', 'group_name', 'TEXT');
// Sweat Assistant's OWN password hash (WP-C2 / Decision D4). Until this, an SA
// login WAS a gym login — `users.email` + the gym credential were the same thing,
// so losing a gym membership meant losing the account. This column makes the SA
// identity independent: scrypt, salted, never the gym's password after the user
// changes either one. NULL means "legacy account, not migrated yet" — the login
// path fills it in transparently on the next successful gym login (see auth.js).
ensureColumn('users', 'password_hash', 'TEXT');
// The user's last-selected gym (WP-C2). NULL means "never chose one" — resolution
// then falls back to their sole linked gym, so single-gym accounts behave exactly
// as they did before multi-gym resolution existed. Deliberately NOT a foreign key:
// a gym can be disabled or removed from gyms.config.js, and a stale value here must
// degrade to the fallback chain rather than break every query for that user.
ensureColumn('users', 'active_gym_id', 'TEXT');
// User priority for contested-slot ordering: lower number = higher priority (default 100 = standard).
// Set to a lower value (e.g. 10) to elevate a user above others in the same release window.
ensureColumn('users', 'priority', 'INTEGER DEFAULT 100');
// Display name cached from CodexFit profile on first login; shown in admin panel.
ensureColumn('users', 'display_name', 'TEXT');
// Full CodexFit profile snapshot (JSON) cached from /profile fetches — powers the admin
// detail view (credits, subscriptions, stats, cutoffs) without an extra live API call.
ensureColumn('users', 'profile_json', 'TEXT');
ensureColumn('users', 'profile_synced_at', 'TEXT');
// Last time this user's client hit the proxy — surfaced as "last seen" in the admin panel.
ensureColumn('users', 'last_seen_at', 'TEXT');
// Class length (minutes) so the calendar feed can compute DTEND. Optional; defaults at serialize.
ensureColumn('booking_cache', 'duration_min', 'INTEGER');
// Street address captured per-event from CodexFit, for the calendar LOCATION field.
ensureColumn('booking_cache', 'location_address', 'TEXT');
ensureColumn('class_history', 'slot_label', 'TEXT');
ensureColumn('class_history', 'spot_section', 'TEXT');
ensureColumn('waitlist_cache', 'location_address', 'TEXT');
ensureColumn('calendar_classes', 'location_address', 'TEXT');
// Per-user rotatable secret token authorising the public-by-URL calendar feed.
ensureColumn('users', 'calendar_token', 'TEXT');
// Original (first-booked) slot on an auto-upgrade monitor, so the calendar can show
// "originally bike 40" after an upgrade. Set once at creation, never mutated.
ensureColumn('auto_upgrades', 'original_slot_id', 'INTEGER');

// The email this account authenticates to THIS gym with (WP-D5).
//
// Until now a gym link stored the password but not the email, because there was
// only ever one gym and `users.email` doubled as its login. Decision D4 broke
// that equivalence deliberately — a Sweat Assistant account is no longer a gym
// account — which left re-authentication with nothing to authenticate AS for any
// user whose gym email differs from their SA email. This column is the last place
// the account still stood in for a gym.
//
// NULL means "we never captured it": either a pre-D5 link to a non-default gym
// (we genuinely don't know, so the user must re-link), or a gym that doesn't
// authenticate by email at all. Callers must treat NULL as "cannot re-login
// unattended", never as "fall back to users.email" — that fallback is exactly
// the account-stands-in-for-gym assumption being removed here.
ensureColumn('user_gyms', 'gym_email', 'TEXT');
// When this link's credential was last PROVEN against the gym — set by
// linkGymAccount and by a successful session renewal, and by nothing else.
// Deliberately not `updated_at`, which moves on any write to the row (a priority
// change, a calendar token rotation) and so would report a connection as freshly
// authenticated when it had not been touched in months.
ensureColumn('user_gyms', 'last_authenticated_at', 'TEXT');

// The instant booking opens for THIS queued class (WP-D8).
//
// A rolling-weekly gym (Psycle) can recompute this from the class date whenever
// it likes. A per-class gym (MarianaTek) cannot: its release instant is
// published per class by the API and has no relationship to any weekday rule, so
// if we don't capture it when the entry is queued there is nothing to recompute
// FROM. NULL means "recompute from the gym's policy", which is correct for
// rolling-weekly gyms and the only sane answer for pre-D8 rows.
ensureColumn('auto_bookings', 'release_at', 'TEXT');

// --- Make the data layer refuse to guess (WP-D6) -----------------------------
//
// WP-D2 gave every per-user table `gym_id TEXT NOT NULL DEFAULT 'psycle-london'`.
// That default was right while application code still wrote single-gym rows, and
// is actively dangerous now that it doesn't: an INSERT that forgets its gym does
// not error, it quietly files the row under Psycle. Silent mis-filing is the
// failure mode this whole phase exists to remove, so the default has to go —
// then a forgotten gym_id is a NOT NULL violation that names itself.
//
// Derives the new table SQL from the LIVE schema in sqlite_master rather than
// restating it, so it cannot drift from what WP-D2 actually created, and so it
// picks up any column added since. Idempotent: a table with no such default is
// skipped, making this a no-op on every boot after the first.
const GYM_SCOPED_TABLES = [
  'studio_preferences', 'settings', 'booking_cache',
  'waitlist_cache', 'calendar_classes', 'auto_bookings', 'auto_upgrades', 'guest_booking_groups',
];
const GYM_DEFAULT_RE = /\s+DEFAULT\s+'psycle-london'/i;

function dropGymIdDefault(table) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || !row.sql || !GYM_DEFAULT_RE.test(row.sql)) return false;

  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name).join(', ');
  const tmp = `${table}__d6migrate`;
  const tmpSql = row.sql
    .replace(GYM_DEFAULT_RE, '')
    .replace(new RegExp(`CREATE TABLE\\s+"?${table}"?`, 'i'), `CREATE TABLE ${tmp}`);

  // Any row still carrying a guessed gym would violate NOT NULL on copy. There
  // should be none — D1/D2 backfilled every existing row — but assert rather than
  // discover it halfway through a DROP.
  const orphans = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE gym_id IS NULL`).get().n;
  if (orphans > 0) {
    console.warn(`[DB] ${table}: ${orphans} row(s) with no gym_id — leaving the default in place.`);
    return false;
  }

  const tx = db.transaction(() => {
    db.exec(tmpSql);
    db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  });
  tx();
  return true;
}

function dropGymIdDefaults() {
  const done = GYM_SCOPED_TABLES.filter((t) => dropGymIdDefault(t));
  if (done.length) console.log(`[DB] WP-D6: dropped the Psycle gym_id default on ${done.join(', ')}.`);
}

// --- Modular multi-gym migration (WP-D1) ---
// Keeps the `gyms` table in sync with the static registry (server/gyms.config.js
// is authoritative), then backfills a `user_gyms` row for every *legacy* user
// against the default gym. A user with `password_hash` is a D4 Sweat Assistant
// account and may deliberately have no gym at all; creating an empty default-gym
// link for one would turn its legitimate 409 NO_GYM_LINKED state into a 401 loop.
// Both steps are idempotent: safe to run on every boot, safe to run against a
// fresh DB, and a no-op on repeat runs. See the `user_gyms` CREATE TABLE comment
// above for why application code doesn't consume this table yet.
function syncGymsFromConfig() {
  const { listGyms } = require('./gyms.config');
  const upsert = db.prepare(`
    INSERT INTO gyms (id, name, provider, enabled, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, provider = excluded.provider, enabled = excluded.enabled, updated_at = CURRENT_TIMESTAMP
  `);
  for (const g of listGyms()) {
    upsert.run(g.id, g.name, g.provider, g.enabled ? 1 : 0);
  }
}

function backfillUserGyms() {
  // `password_hash IS NULL` is the durable migration boundary: pre-D4 accounts
  // had only a gym credential, while D4 accounts receive their own password at
  // signup and can intentionally remain gym-less until they explicitly link one.
  const users = db.prepare('SELECT * FROM users WHERE password_hash IS NULL').all();
  if (users.length === 0) return;

  const already = new Set(
    db.prepare('SELECT user_id FROM user_gyms WHERE gym_id = ?').all(DEFAULT_GYM_ID).map((r) => r.user_id)
  );
  const insert = db.prepare(`
    INSERT INTO user_gyms
      (user_id, gym_id, gym_email, encrypted_password, session_json, display_name, profile_json, profile_synced_at, calendar_token, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);
  const tx = db.transaction(() => {
    for (const u of users) {
      if (already.has(u.id)) continue;
      const session = u.jwt ? JSON.stringify({ accessToken: u.jwt, expiresAt: u.jwt_expires_at || null }) : null;
      insert.run(
        u.id, DEFAULT_GYM_ID, u.email, u.encrypted_password, session,
        u.display_name || null, u.profile_json || null, u.profile_synced_at || null,
        u.calendar_token || null, u.priority ?? 100
      );
    }
  });
  tx();
}

// Backfill gym_email on links that predate the column (WP-D5).
//
// Only the DEFAULT gym is backfillable, and only because `users.email` provably
// WAS its login: before D4 an SA login was a CodexFit login, and handleLogin
// passed `users.email` straight to the default gym's provider. For any other gym
// the email was collected, used, and thrown away — we do not know it, and
// guessing `users.email` would silently re-assert the coupling D4 removed. Those
// links stay NULL and surface as "re-link needed".
//
// Idempotent: only fills NULLs, so it is a no-op on every boot after the first.
function backfillGymEmails() {
  db.prepare(`
    UPDATE user_gyms
       SET gym_email = (SELECT email FROM users WHERE users.id = user_gyms.user_id)
     WHERE gym_email IS NULL AND gym_id = ?
  `).run(DEFAULT_GYM_ID);
}

// F-7 Stage B: admin-edited presentation overrides live in server_kv as one JSON
// map { gymId: presentation }. Re-validated on every boot; a bad or stale entry
// is skipped (registry value stays) rather than blocking startup.
const PRESENTATION_KV = 'gym_presentation_overrides';
function readPresentationOverrides() {
  const row = db.prepare('SELECT value FROM server_kv WHERE key = ?').get(PRESENTATION_KV);
  try { const v = row ? JSON.parse(row.value) : {}; return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
function writePresentationOverrides(map) {
  db.prepare('INSERT OR REPLACE INTO server_kv (key, value) VALUES (?, ?)').run(PRESENTATION_KV, JSON.stringify(map));
}
function applyPresentationOverrides() {
  const { setPresentation } = require('./gyms.config');
  for (const [gymId, p] of Object.entries(readPresentationOverrides())) {
    try { setPresentation(gymId, p); } catch (e) { console.warn(`[gyms] ignoring stored presentation for ${gymId}: ${e.message}`); }
  }
}

syncGymsFromConfig();
applyPresentationOverrides();
backfillUserGyms();
backfillGymEmails();

// --- Modular multi-gym migration (WP-D2) ---
// Add gym_id to every per-user table so rows can be scoped to a specific gym
// link. Two tables (auto_bookings, auto_upgrades) have no UNIQUE constraint —
// a plain defaulted column is enough, and existing + future rows are backfilled
// automatically by the column DEFAULT. The other five have a UNIQUE constraint
// that must widen to include gym_id; SQLite cannot ALTER a constraint in place,
// so those are rebuilt: create the new-shape table, copy data across (gym_id is
// omitted from the copy so it picks up the DEFAULT), drop the old table, rename.
// Idempotent — skipped per-table if gym_id already exists. As with WP-D1, this
// is additive-only: no consumer code reads/writes gym_id yet (that's WP-D4).
// The gym id is a LITERAL in these migration statements on purpose. They describe
// the schema as it was at WP-D2, and history must not change if DEFAULT_GYM_ID
// ever does — reading it from config here would silently rewrite what past
// migrations did to existing databases. WP-D6's dropGymIdDefaults() strips these
// defaults again immediately afterwards; they exist only so the ALTER is legal
// (SQLite requires a default when adding a NOT NULL column).
ensureColumn('auto_bookings', 'gym_id', "TEXT DEFAULT 'psycle-london'");
// Persisted at queue time: a queue row outlives the timetable metadata that
// could otherwise resolve the photo by name, and MarianaTek's instructor list
// only covers the upcoming-class window.
ensureColumn('auto_bookings', 'instructor_image_url', 'TEXT');
// Class length in minutes, so competing-booking detection (C5-3) can test time overlap. Nullable: legacy rows.
ensureColumn('auto_bookings', 'duration_min', 'INTEGER');
ensureColumn('auto_upgrades', 'gym_id', "TEXT DEFAULT 'psycle-london'");

function rebuildWithGymId(table, tmpCreateSql) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.length === 0 || cols.some((c) => c.name === 'gym_id')) return; // missing table or already migrated
  const tmpTable = `${table}__d2migrate`;
  const oldCols = cols.map((c) => c.name).join(', ');
  const tx = db.transaction(() => {
    db.exec(tmpCreateSql);
    db.exec(`INSERT INTO ${tmpTable} (${oldCols}) SELECT ${oldCols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${tmpTable} RENAME TO ${table}`);
  });
  tx();
}

// Shared spot maps: UNIQUE(user_id, studio_id) -> UNIQUE(user_id, gym_id, studio_id).
rebuildWithGymId('studio_preferences', `
  CREATE TABLE studio_preferences__d2migrate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    studio_id INTEGER NOT NULL,
    preferences TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    gym_id TEXT NOT NULL DEFAULT 'psycle-london',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id, studio_id)
  )
`);

// Settings: UNIQUE(user_id) -> UNIQUE(user_id, gym_id) (one settings blob per gym link).
rebuildWithGymId('settings', `
  CREATE TABLE settings__d2migrate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    preferences TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    gym_id TEXT NOT NULL DEFAULT 'psycle-london',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id)
  )
`);

// Booking cache: UNIQUE(user_id, booking_id) -> UNIQUE(user_id, gym_id, booking_id)
// (provider booking IDs are independent numbering spaces across gyms).
rebuildWithGymId('booking_cache', `
  CREATE TABLE booking_cache__d2migrate (
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
    duration_min INTEGER,
    location_address TEXT,
    gym_id TEXT NOT NULL DEFAULT 'psycle-london',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id, booking_id)
  )
`);

// Waitlist cache: UNIQUE(user_id, event_id) -> UNIQUE(user_id, gym_id, event_id).
rebuildWithGymId('waitlist_cache', `
  CREATE TABLE waitlist_cache__d2migrate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    start_at TEXT,
    class_name TEXT,
    group_name TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    studio_id INTEGER,
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
    location_address TEXT,
    gym_id TEXT NOT NULL DEFAULT 'psycle-london',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id, event_id)
  )
`);

// Calendar classes: UNIQUE(user_id, event_id) -> UNIQUE(user_id, gym_id, event_id).
rebuildWithGymId('calendar_classes', `
  CREATE TABLE calendar_classes__d2migrate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id INTEGER NOT NULL,
    start_at TEXT,
    duration_min INTEGER,
    class_name TEXT,
    group_name TEXT,
    instructor_name TEXT,
    studio_name TEXT,
    location_name TEXT,
    slot_label TEXT,
    original_slot_label TEXT,
    status TEXT,
    upgrade_note TEXT,
    sequence INTEGER DEFAULT 0,
    content_hash TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    location_address TEXT,
    gym_id TEXT NOT NULL DEFAULT 'psycle-london',
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (gym_id) REFERENCES gyms(id),
    UNIQUE(user_id, gym_id, event_id)
  )
`);

// Runs LAST of the schema migrations: WP-D2's rebuilds above create the tables
// carrying the Psycle default, and D1's backfill needs it while it populates
// existing rows. Only once both have finished is it safe — and correct — to take
// the training wheels off. See dropGymIdDefaults() above.
dropGymIdDefaults();

// --- Sweat Assistant account password hashing (Decision D4) ---
// node:crypto scrypt — deliberately no new dependency. Parameters are stored in
// the hash string so they can be raised later without invalidating existing rows.
const nodeCrypto = require('crypto');
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = nodeCrypto.randomBytes(16);
  const derived = nodeCrypto.scryptSync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = nodeCrypto.scryptSync(String(password), salt, expected.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    // Constant-time — a length mismatch would make timingSafeEqual throw.
    return derived.length === expected.length && nodeCrypto.timingSafeEqual(derived, expected);
  } catch (_) {
    return false;
  }
}

// --- Modular multi-gym account/session resolution (WP-D3 seam, WP-C2 implementation) ---
//
// This replaced a stub that always returned DEFAULT_GYM_ID. It is called from ~10
// places inside db.js — every auth, session, priority and calendar-token read —
// and none of those call sites (nor their callers in auth.js / server.js /
// scheduler.js / poller.js / calendar.js / admin.js) pass a gym. Threading one
// through all of them was the thing WP-D3 explicitly bought its way out of, so
// the request's gym arrives out-of-band instead, via AsyncLocalStorage.
//
// better-sqlite3 is synchronous, so a db call made anywhere in an awaited request
// chain still sees the store. Background work (scheduler/poller/calendar cron)
// runs with no store at all and falls through to the persisted/sole-gym path —
// per-row gym routing for those services is WP-S3, not this slice.
const { AsyncLocalStorage } = require('async_hooks');
const gymContext = new AsyncLocalStorage();

/**
 * Run `fn` with an explicit active gym for one user. The caller MUST have already
 * verified the user is linked to that gym — resolveActiveGymId trusts this.
 */
function runWithGymContext(userId, gymId, fn) {
  return gymContext.run({ userId: String(userId), gymId, memo: new Map() }, fn);
}

function resolveActiveGymId(userId) {
  if (userId == null) return DEFAULT_GYM_ID;
  const ctx = gymContext.getStore();

  // 1. The gym this request explicitly asked for. Scoped to its own user on
  //    purpose: an admin request reading ANOTHER account's row (admin.js does
  //    exactly this) must not inherit the admin's own active gym.
  if (ctx && ctx.gymId && ctx.userId === String(userId)) return ctx.gymId;

  // Memoise the fallback chain per request — resolveActiveGymId is called
  // several times while serving one request and steps 2/3 both hit the DB.
  if (ctx && ctx.memo && ctx.memo.has(String(userId))) return ctx.memo.get(String(userId));

  const resolved = resolvePersistedGymId(userId);
  if (ctx && ctx.memo) ctx.memo.set(String(userId), resolved);
  return resolved;
}

/**
 * Resolve the gym for a per-gym WRITE — and refuse to guess (stage 1 of the
 * active-gym audit, Documentation/Archive/2026-09-26/Backlog/active-gym-audit.md).
 *
 * There is no "active gym" in this product: one account, many gyms, every list
 * merged. `resolveActiveGymId` still guesses one for the ~17 accessors that
 * cannot yet be told which gym they mean, and that guess is the single largest
 * source of cross-gym bugs — it is right on a single-gym account, so it survives
 * review, then silently writes to the wrong gym on a multi-gym one. Three such
 * bugs shipped on 2026-09-15 alone (auto-book queued against the wrong gym,
 * auto-upgrade monitors stored against the wrong gym, credits read from it).
 *
 * So: an explicit gym wins, the request's own gym context is next, and a
 * single-gym account is unambiguous. A multi-gym account with neither is a bug
 * at the CALL SITE, and gets an exception naming it rather than a plausible
 * wrong answer.
 */
function resolveGymStrict(userId, explicitGymId, opName) {
  if (explicitGymId) return explicitGymId;
  const ctx = gymContext.getStore();
  if (ctx && ctx.gymId && ctx.userId === String(userId)) return ctx.gymId;

  const links = db.prepare('SELECT gym_id FROM user_gyms WHERE user_id = ?').all(userId);
  if (links.length > 1) {
    throw new Error(
      `${opName}: no gym specified for an account linked to ${links.length} gyms (user ${userId}). `
      + 'There is no active gym — pass the row\'s own gymId explicitly.',
    );
  }
  return resolveActiveGymId(userId);
}

// The "stored choice" step (a persisted `users.active_gym_id`) was removed in
// the active-gym audit's stage 4 (2026-09-15): the client switcher it served
// was already deleted, `POST /api/my-gyms/active` had no remaining caller, and
// keeping a rememberable "current gym" is the exact concept this product
// doesn't have — every list is merged, and every real write now names its own
// gym explicitly (stage 1-3). The column itself is left in place (harmless,
// unread) rather than run a destructive migration for a nullable field — same
// call already made for `users.encrypted_password`.
function resolvePersistedGymId(userId) {
  const links = db.prepare('SELECT gym_id FROM user_gyms WHERE user_id = ?').all(userId);

  // 1. Sole linked gym. This is what every account looks like today, and it is
  //    what makes this a no-op for existing single-gym users.
  if (links.length === 1) return links[0].gym_id;

  // 2. Nothing to go on (no links yet — pre-backfill, or mid-signup), or
  //    several links with no per-request gym named. Default gym keeps
  //    background work (cron, reads with no context) landing somewhere stable.
  if (links.some((l) => l.gym_id === DEFAULT_GYM_ID)) return DEFAULT_GYM_ID;
  return links.length > 0 ? links[0].gym_id : DEFAULT_GYM_ID;
}

// Merge a bare `users` identity row with its resolved-gym `user_gyms` link into the
// legacy "users row" shape every call site already expects (user.jwt, user.priority,
// user.calendar_token, ...). This is what makes user_gyms the actual source of truth
// for auth/session data without touching call sites in auth.js/server.js/scheduler.js/
// poller.js/admin.js/calendar.js — see PROGRESS.md WP-D3 handoff for the full rationale.
// Falls back to the (vestigial, dual-written) `users` columns if no gym link exists yet,
// which should only happen for a user created before the D1 backfill ran.
// --- Settings scope split (WP-D6) -------------------------------------------
//
// Settings keys that belong to the PERSON, not to any one gym. Everything not
// listed here is treated as gym-scoped.
//
// The default runs this way round deliberately. The gym-scoped set is the one
// that grows — every new provider capability tends to add a gym-derived key —
// and forgetting to list one of those would leak it across gyms silently, which
// is the exact failure mode this phase exists to remove. Forgetting to list an
// account-scoped key is merely annoying: the user sets it once per gym, and can
// see that they did. Visible annoyance beats invisible wrongness.
//
// Deliberately gym-scoped, in case any of these look account-ish:
//   detectedBookingOffset / advancedBooking / advancedBookingCredit /
//   manualBookingWindow* — all describe ONE gym's booking window
//   cartInstanceId       — a provider-side cart id
//   autoBookFavourites   — provider bookmark identifiers
const ACCOUNT_SCOPED_SETTING_KEYS = new Set([
  'notifications',        // per-type push preferences — the person's choice
  'debugMode',            // app-level developer toggle
  'prefetchWeeks',
  'theme',
  // `calendar` moved here on 2026-09-14. It WAS gym-scoped because the feed
  // token lived on user_gyms, which made the feed per-gym — one .ics URL per
  // gym, each showing a third of your week. A person has one calendar; they
  // subscribe once and expect every class in it. The token therefore moved to
  // users.calendar_token (an account-level column that already existed), the
  // feed now fans out across every linked gym, and this key follows.
  //
  // NOTE the trap this replaces: while the token lived on user_gyms, listing
  // `calendar` here would have made getCalendarEnabledUserIds find nobody and
  // silently stop the feed cron. That function now reads account_settings, so
  // the two are consistent — change them together or not at all.
  'calendar',
  // `autoBookPaused` moved here on 2026-09-15. It was gym-scoped by the default
  // rule, but the UI is a single "Pause Auto-Book" button sitting above a
  // MERGED queue — there is no gym for it to belong to, and the member plainly
  // means "stop auto-booking for me". Left gym-scoped it was also unsavable:
  // the Auto-Book tab has no single gym to name.
  'autoBookPaused',
  // Saved default timetable filters. The timetable is a MERGED multi-gym view,
  // so the filters (which include a gym selector) belong to the person.
  'defaultFilters',
  // A person chooses what the app calls them once; gym profiles are merely the
  // onboarding suggestion and must never change this account-level choice.
  'firstName',
]);

function parseJsonOr(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (_) { return fallback; }
}

function splitSettingsByScope(preferences) {
  const account = {};
  const gym = {};
  for (const [k, v] of Object.entries(preferences || {})) {
    (ACCOUNT_SCOPED_SETTING_KEYS.has(k) ? account : gym)[k] = v;
  }
  return { account, gym };
}

// One-time move of account-scoped keys out of the per-gym rows (WP-D6).
// Idempotent: a row whose account keys have already been lifted has none left to
// lift, so the second pass is a no-op. Runs across ALL gym rows, not just the
// default, so a pre-split second-gym link contributes its account keys too.
function splitExistingSettings() {
  const rows = db.prepare('SELECT user_id, gym_id, preferences FROM settings').all();
  if (rows.length === 0) return;
  const readAcct = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?');
  const writeAcct = db.prepare(`
    INSERT INTO account_settings (user_id, preferences, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
  `);
  const writeGym = db.prepare('UPDATE settings SET preferences = ? WHERE user_id = ? AND gym_id = ?');
  const tx = db.transaction(() => {
    for (const r of rows) {
      const { account, gym } = splitSettingsByScope(parseJsonOr(r.preferences, {}));
      if (Object.keys(account).length === 0) continue; // already split
      // Merge rather than overwrite: two gym rows may each carry account keys.
      const existing = parseJsonOr((readAcct.get(r.user_id) || {}).preferences, {});
      writeAcct.run(r.user_id, JSON.stringify({ ...existing, ...account }));
      writeGym.run(JSON.stringify(gym), r.user_id, r.gym_id);
    }
  });
  tx();
}
splitExistingSettings();

// Settings-scope correction (2026-09-12): Auto-Upgrade operates against one
// gym's provider, capabilities, bookings and polling cost, so its controls are
// gym-scoped. Earlier WP-D6 code lifted three keys into account_settings while
// `autoUpgradeKeepOriginalByDefault` remained gym-scoped by accident. Backfill
// the former account values onto every existing link, preserve an already-set
// gym value, then remove the account copies. Idempotent: after the first pass
// there are no account keys left to migrate.
const AUTO_UPGRADE_GYM_KEYS = [
  'autoUpgradeEnabled',
  'autoUpgradeByDefault',
  'autoUpgradeInterval',
  'autoUpgradeKeepOriginalByDefault',
];

function migrateAutoUpgradeSettingsScope() {
  const accountRows = db.prepare('SELECT user_id, preferences FROM account_settings').all();
  if (accountRows.length === 0) return;

  const linkedGyms = db.prepare('SELECT gym_id FROM user_gyms WHERE user_id = ?');
  const readGym = db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?');
  const writeGym = db.prepare(`
    INSERT INTO settings (user_id, gym_id, preferences, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, gym_id) DO UPDATE SET
      preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
  `);
  const writeAccount = db.prepare(`
    UPDATE account_settings SET preferences = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?
  `);

  const tx = db.transaction(() => {
    for (const row of accountRows) {
      const account = parseJsonOr(row.preferences, {});
      const values = {};
      for (const key of AUTO_UPGRADE_GYM_KEYS) {
        if (Object.prototype.hasOwnProperty.call(account, key)) values[key] = account[key];
      }
      if (Object.keys(values).length === 0) continue;

      for (const { gym_id: gymId } of linkedGyms.all(row.user_id)) {
        const existingRow = readGym.get(row.user_id, gymId);
        const existing = parseJsonOr(existingRow && existingRow.preferences, {});
        // Existing per-gym values win; account values are only a backfill.
        writeGym.run(row.user_id, gymId, JSON.stringify({ ...values, ...existing }));
      }

      for (const key of AUTO_UPGRADE_GYM_KEYS) delete account[key];
      writeAccount.run(JSON.stringify(account), row.user_id);
    }
  });
  tx();
}
migrateAutoUpgradeSettingsScope();

/**
 * Promote the `calendar` setting from gym scope to account scope (2026-09-14).
 *
 * Runs in the OPPOSITE direction to migrateAutoUpgradeSettingsScope above: that
 * one fanned an account key out to every gym; this one folds every gym's copy
 * back into one account value.
 *
 * Without it, an existing subscriber's `calendar.enabled` stays in their
 * `settings` row where nothing reads it any more, getCalendarEnabledUserIds
 * finds nobody, and the feed cron silently stops for everyone who already had
 * it on — no error, just a calendar that quietly stops updating. That is the
 * failure this migration exists to prevent, so do not remove it as "old".
 *
 * Idempotent: once the gym rows no longer carry `calendar`, it is a no-op.
 * "Enabled anywhere" wins, because the user did opt in; the richest non-empty
 * settings object is kept so alarm/includeTentative choices survive.
 */
function migrateCalendarSettingsToAccountScope() {
  const gymRows = db.prepare('SELECT user_id, gym_id, preferences FROM settings').all();
  if (gymRows.length === 0) return;

  const byUser = new Map();
  for (const row of gymRows) {
    const prefs = parseJsonOr(row.preferences, {});
    if (!Object.prototype.hasOwnProperty.call(prefs, 'calendar')) continue;
    const cal = prefs.calendar || {};
    const prev = byUser.get(row.user_id);
    if (!prev) byUser.set(row.user_id, cal);
    else {
      byUser.set(row.user_id, {
        ...prev,
        ...cal,
        enabled: !!(prev.enabled || cal.enabled),
      });
    }
  }
  if (byUser.size === 0) return;

  const readAccount = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?');
  const writeAccount = db.prepare(`
    INSERT INTO account_settings (user_id, preferences, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
  `);
  const writeGym = db.prepare('UPDATE settings SET preferences = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND gym_id = ?');

  const tx = db.transaction(() => {
    for (const [userId, calendar] of byUser) {
      const account = parseJsonOr(readAccount.get(userId)?.preferences, {});
      // An account value already set by the new code wins over the old gym copy.
      if (!Object.prototype.hasOwnProperty.call(account, 'calendar')) {
        account.calendar = calendar;
        writeAccount.run(userId, JSON.stringify(account));
      }
    }
    for (const row of gymRows) {
      const prefs = parseJsonOr(row.preferences, {});
      if (!Object.prototype.hasOwnProperty.call(prefs, 'calendar')) continue;
      delete prefs.calendar;
      writeGym.run(JSON.stringify(prefs), row.user_id, row.gym_id);
    }
  });
  tx();
}
migrateCalendarSettingsToAccountScope();

/**
 * Fold each gym's `autoBookPaused` into one account-level value (2026-09-15).
 *
 * Same shape as the calendar migration above, and the same trap: `getUserSettings`
 * spreads the gym blob OVER the account one, so leaving a stale gym copy behind
 * would silently override the account value forever. The key must be deleted
 * from the gym rows, not just copied up.
 *
 * Conflict rule: paused ANYWHERE wins. This is a safety switch on an automated
 * action — erring towards "don't book on my behalf" is the recoverable
 * direction; the member can unpause in one tap.
 */
function migrateAutoBookPausedToAccountScope() {
  const gymRows = db.prepare('SELECT user_id, gym_id, preferences FROM settings').all();
  if (gymRows.length === 0) return;

  const byUser = new Map();
  for (const row of gymRows) {
    const prefs = parseJsonOr(row.preferences, {});
    if (!Object.prototype.hasOwnProperty.call(prefs, 'autoBookPaused')) continue;
    byUser.set(row.user_id, !!(byUser.get(row.user_id) || prefs.autoBookPaused));
  }
  if (byUser.size === 0) return;

  const readAccount = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?');
  const writeAccount = db.prepare(`
    INSERT INTO account_settings (user_id, preferences, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET
      preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
  `);
  const writeGym = db.prepare('UPDATE settings SET preferences = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND gym_id = ?');

  const tx = db.transaction(() => {
    for (const [userId, paused] of byUser) {
      const account = parseJsonOr(readAccount.get(userId)?.preferences, {});
      if (!Object.prototype.hasOwnProperty.call(account, 'autoBookPaused')) {
        account.autoBookPaused = paused;
        writeAccount.run(userId, JSON.stringify(account));
      }
    }
    for (const row of gymRows) {
      const prefs = parseJsonOr(row.preferences, {});
      if (!Object.prototype.hasOwnProperty.call(prefs, 'autoBookPaused')) continue;
      delete prefs.autoBookPaused;
      writeGym.run(JSON.stringify(prefs), row.user_id, row.gym_id);
    }
  });
  tx();
}
migrateAutoBookPausedToAccountScope();

function mergeUserWithGym(user, gymId) {
  if (!user) return null;
  const ug = db.prepare('SELECT * FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(user.id, gymId);
  let session = null;
  if (ug && ug.session_json) { try { session = JSON.parse(ug.session_json); } catch (_) {} }
  return {
    ...user,
    // `|| null` so the vestigial empty-string placeholder a gym-less account
    // carries can never be handed to decrypt() as if it were a real credential.
    encrypted_password: (ug ? ug.encrypted_password : user.encrypted_password) || null,
    jwt: session ? session.accessToken : null,
    jwt_expires_at: session ? session.expiresAt : null,
    priority: ug ? ug.priority : (user.priority ?? 100),
    display_name: ug ? ug.display_name : user.display_name,
    profile_json: ug ? ug.profile_json : user.profile_json,
    profile_synced_at: ug ? ug.profile_synced_at : user.profile_synced_at,
    calendar_token: ug ? ug.calendar_token : user.calendar_token,
    gym_id: gymId,
    // The email this account logs in to THIS gym with (WP-D5). Deliberately a
    // SEPARATE field from `.email`, which stays the Sweat Assistant account
    // identity — conflating them is the coupling D4 exists to break. NULL means
    // "not captured": re-authentication needs the user, not a fallback.
    gym_email: ug ? ug.gym_email : null,
  };
}

// C7-3: admin audit log. No FK on target_user_id on purpose: a 'user.delete' row must outlive the user.
const AUDIT_SECRET_KEY = /pass(word)?|token|secret|jwt|authorization/i;
function redactAudit(v, depth = 0) {
  if (v === null || typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => redactAudit(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = AUDIT_SECRET_KEY.test(k) ? '[redacted]' : redactAudit(val, depth + 1);
  return out;
}
function recordAdminAudit({ action, targetUserId = null, ip = null, detail = null, actor = 'admin' }) {
  try {
    db.prepare('INSERT INTO admin_audit_log (actor, action, target_user_id, ip, detail) VALUES (?, ?, ?, ?, ?)')
      .run(actor, String(action), targetUserId, ip, detail ? JSON.stringify(redactAudit(detail)) : null);
  } catch (err) {
    console.error('[Audit] failed to record admin action:', err.message); // never break the admin action itself
  }
}
function listAdminAudit({ limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  return db.prepare('SELECT * FROM admin_audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(lim, off)
    .map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null }));
}

// Helper methods
module.exports = {
  recordAdminAudit,
  listAdminAudit,
  // Direct access if needed
  db,
  migrateAutoUpgradeSettingsScope,
  migrateCalendarSettingsToAccountScope,

  readPresentationOverrides,
  writePresentationOverrides,
  applyPresentationOverrides,

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
  // Returns the account row merged with its resolved-gym link (WP-D3) — see
  // mergeUserWithGym above. `user.jwt`, `.encrypted_password`, `.priority`,
  // `.display_name`, `.profile_json`, `.profile_synced_at`, `.calendar_token` all
  // resolve from `user_gyms` transparently; every existing call site is unaffected.
  getUserById(id) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return mergeUserWithGym(user, resolveActiveGymId(id));
  },
  createUser(email, encryptedPassword) {
    // All new users share priority 200 — one fixed tier below the founding users (100).
    // Admins can promote individuals via the admin panel; new signups always start here.
    // `users.*` columns below are kept in sync (dual-write) for defense-in-depth during
    // the WP-D3 transition, but user_gyms is the real source of truth going forward.
    const result = db.prepare('INSERT INTO users (email, encrypted_password, priority) VALUES (?, ?, 200)').run(email, encryptedPassword);
    const userId = result.lastInsertRowid;
    // Bootstrap the default gym link — this is the "first gym login creates the
    // account + first user_gyms row" flow from PLAN.md D3, scoped to today's one
    // gym. Additional gyms link via upsertUserGym directly (see D1) once Phase 5's
    // client gym picker exists.
    // gym_email is `email` here and only here: this path IS the gym-login flow
    // (handleLogin), so the address was just proven against the default gym.
    // Signup — which creates an account with no gym — goes through createAccount()
    // instead and must never seed a gym email it has not verified.
    this.upsertUserGym(userId, DEFAULT_GYM_ID, { gym_email: email, encrypted_password: encryptedPassword, priority: 200 });
    return userId;
  },
  // Create a Sweat Assistant account with NO gym attached (Decision D4).
  // Distinct from createUser(), which bootstraps a default-gym link because it
  // models the legacy "first gym login creates the account" flow. Signup is
  // gym-independent by design — the whole point is that the account can outlive
  // any membership, so linking is a separate, later step.
  createAccount(email, password) {
    // `users.encrypted_password` is NOT NULL — a leftover from when an account
    // literally WAS a gym login. It has been vestigial since WP-D3 (user_gyms is
    // the source of truth), but dropping the constraint means rebuilding `users`,
    // which ~10 tables cascade-reference; not worth that risk for a dead column.
    // Writing '' instead, and mergeUserWithGym treats an empty value as absent so
    // nothing downstream can mistake it for a credential. Removing the column
    // properly is on the backlog.
    const result = db.prepare("INSERT INTO users (email, encrypted_password, priority) VALUES (?, '', 200)").run(email);
    const userId = result.lastInsertRowid;
    this.setAccountPassword(userId, password);
    return userId;
  },

  // Invalidate every stored gym credential on the account. Called by account
  // recovery: if an account needed recovering, its stored secrets should not be
  // assumed safe. Clearing the password and session (rather than deleting the
  // link) keeps the user's queue, spot maps and priority tier intact — they just
  // re-authenticate each gym before those can be used again. Returns the gym ids
  // reset so the UI can name them.
  //
  // `exceptGymId` exists only for callers that have *just* verified a specific
  // gym in the same flow; recovery no longer does (it stopped using gym logins
  // as proof of identity), so it passes nothing and everything is reset.
  resetGymCredentials(userId, exceptGymId = null) {
    const others = db.prepare('SELECT gym_id FROM user_gyms WHERE user_id = ? AND gym_id IS NOT ?')
      .all(userId, exceptGymId).map((r) => r.gym_id);
    const tx = db.transaction(() => {
      for (const gymId of others) {
        db.prepare(`UPDATE user_gyms SET encrypted_password = NULL, session_json = NULL,
                    status = 'needs_relogin', updated_at = CURRENT_TIMESTAMP,
                    relogin_failures = 0, relogin_rejections = 0, relogin_suspended = 0,
                    last_relogin_failure_at = NULL, last_relogin_error = NULL
                    WHERE user_id = ? AND gym_id = ?`).run(userId, gymId);
      }
    });
    tx();
    return others;
  },

  // Both fire from a LOGIN — one specific gym, known to the caller at the point
  // of call (the gym that was just authenticated against). Accepting it
  // explicitly avoids a second, independent resolution landing on a different
  // gym than the one the login actually used.
  updateUserCredentials(userId, encryptedPassword, jwt, jwtExpiresAt, gymId = null) {
    db.prepare('UPDATE users SET encrypted_password = ?, jwt = ?, jwt_expires_at = ? WHERE id = ?')
      .run(encryptedPassword, jwt, jwtExpiresAt, userId);
    this.upsertUserGym(userId, gymId || resolveActiveGymId(userId), {
      encrypted_password: encryptedPassword,
      session_json: jwt ? JSON.stringify({ accessToken: jwt, expiresAt: jwtExpiresAt || null }) : null,
      // A login just proved the credential against the gym (U1-9). Only when a
      // session was actually issued — storing a password alone proves nothing.
      ...(jwt ? { last_authenticated_at: new Date().toISOString() } : {}),
    });
  },
  updateUserJWT(userId, jwt, jwtExpiresAt, gymId = null) {
    db.prepare('UPDATE users SET jwt = ?, jwt_expires_at = ? WHERE id = ?')
      .run(jwt, jwtExpiresAt, userId);
    this.upsertUserGym(userId, gymId || resolveActiveGymId(userId), {
      session_json: jwt ? JSON.stringify({ accessToken: jwt, expiresAt: jwtExpiresAt || null }) : null,
      ...(jwt ? { last_authenticated_at: new Date().toISOString() } : {}), // U1-9, as above
    });
  },
  // Persist a full AuthSession against an EXPLICIT gym (WP-D7).
  //
  // updateUserJWT above resolves the active gym and stores only an access token.
  // Neither is right for background session renewal: the cron has no request
  // context and may be renewing a gym the user isn't currently looking at, and
  // dropping `refreshToken`/`meta` would throw away exactly what a refresh-token
  // platform like MarianaTek needs to renew again next time.
  setGymSession(userId, gymId, session) {
    if (!gymId) throw new Error('setGymSession requires an explicit gymId');
    this.upsertUserGym(userId, gymId, {
      session_json: session ? JSON.stringify(session) : null,
      // A new session means the stored credential was just proven against the
      // gym. Only stamped when a session is actually issued — clearing a session
      // (a failed renewal) must not look like a successful authentication.
      ...(session ? { last_authenticated_at: new Date().toISOString() } : {}),
    });
    // Dual-write the vestigial users.* columns only when this IS the active gym,
    // so renewing a background gym can't overwrite the active one's token.
    if (gymId === resolveActiveGymId(userId)) {
      db.prepare('UPDATE users SET jwt = ?, jwt_expires_at = ? WHERE id = ?')
        .run(session ? session.accessToken : null, session ? (session.expiresAt || null) : null, userId);
    }
  },
  getUserSession(userId, gymId) {
    const resolvedGym = gymId || resolveActiveGymId(userId);
    const link = this.getUserGym(userId, resolvedGym);
    if (link && link.session_json) {
      try {
        const s = JSON.parse(link.session_json);
        if (s && s.accessToken) return s;
      } catch (_) {}
    }
    const user = this.getUserById(userId);
    return user?.jwt ? { accessToken: user.jwt } : null;
  },
  updateUserDisplayName(userId, displayName, gymId = null) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
    this.upsertUserGym(userId, gymId || resolveActiveGymId(userId), { display_name: displayName });
  },
  // Cache the full CodexFit profile JSON for the admin detail view. Also backfills
  // display_name so the user list stays populated even if it was never set.
  // A profile is per gym — caching it against a guessed gym overwrites that
  // gym's real profile with another's. Callers wrap this in try/catch (it's
  // always best-effort), so a strict throw here is safe to let surface.
  cacheUserProfile(userId, profile, gymId = null) {
    if (!profile || typeof profile !== 'object') return;
    const targetGym = resolveGymStrict(userId, gymId, 'cacheUserProfile');
    const displayName = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || null;
    const profileJson = JSON.stringify(profile);
    const profileSyncedAt = new Date().toISOString();
    // The vestigial `users.*` dual-write only means anything for the ACTIVE gym
    // (same rule as setGymSession) — writing it for a background gym would show
    // that gym's name/profile in places that read the account-level columns.
    if (targetGym === resolveActiveGymId(userId)) {
      db.prepare('UPDATE users SET profile_json = ?, profile_synced_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(profileJson, userId);
      if (displayName) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
    }
    const fields = { profile_json: profileJson, profile_synced_at: profileSyncedAt };
    if (displayName) fields.display_name = displayName;
    this.upsertUserGym(userId, targetGym, fields);
  },
  // Called from `authenticateToken`, i.e. on EVERY authenticated request, so it
  // is throttled in SQL rather than firing a write per call. The predicate does
  // the throttling without a preceding read.
  //
  // It used to live on `/api/proxy/*` only, which made it CodexFit-only by
  // accident: a MarianaTek account never touches the proxy, so its `last_seen_at`
  // never moved and the admin panel reported every JAB user as dormant. As the
  // client migrated off the proxy the same staleness started reaching Psycle
  // accounts too.
  touchUserLastSeen(userId) {
    db.prepare(`
      UPDATE users SET last_seen_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-5 minutes'))
    `).run(userId);
  },

  // Auto-bookings
  getPendingAutoBookings() {
    // ── Gym scoping rule for everything below (WP-D6) ────────────────────────
    //
    // Two kinds of query, and getting them the wrong way round breaks something
    // silently in one direction or the other:
    //
    //   Per-user accessors  → scope to resolveActiveGymId(userId). These serve a
    //     request or render a list, so they must show one gym's rows only. Note
    //     several of these tables key on PROVIDER ids (studio_id, event_id) which
    //     are only unique within a gym — Psycle studio 138 and a JAB studio 138
    //     are different rooms, and an unscoped read merges them.
    //
    //   Cross-user background scanners → NO gym filter, but must select gym_id so
    //     the caller can route per row. A user's JAB auto-book must fire while
    //     their ACTIVE gym is Psycle; filtering these to the active gym would
    //     quietly stop background work for every non-active gym. That is
    //     getPendingAutoBookings, getActiveAutoUpgrades and getAllBookingCache.
    //
    // Accessors keyed on a table's own primary key (id) are deliberately left
    // alone: `id` is globally unique, so adding a gym predicate buys nothing and
    // introduces a silent no-op whenever the row's gym isn't the active one.

    // JOIN user_gyms (scoped to each booking's own gym_id, WP-D3) for gym-specific
    // priority so the scheduler can tier-sort + shuffle within tier. LEFT JOIN +
    // COALESCE defends against a booking whose gym link is somehow missing.
    // Lower priority value = higher precedence (default 100; set to e.g. 10 for VIPs).
    return db.prepare(`
      SELECT ab.*, COALESCE(ug.priority, 100) AS priority
      FROM auto_bookings ab
      LEFT JOIN user_gyms ug ON ug.user_id = ab.user_id AND ug.gym_id = ab.gym_id
      WHERE ab.status = 'pending' AND ab.executed_at IS NULL
      ORDER BY priority ASC, ab.created_at ASC
    `).all();
  },
  getUserAutoBookings(userId, gymId = undefined) {
    if (gymId === 'all') {
      return db.prepare('SELECT * FROM auto_bookings WHERE user_id = ? ORDER BY id DESC').all(userId);
    }
    const resolvedGym = gymId !== undefined ? gymId : resolveActiveGymId(userId);
    if (!resolvedGym) {
      return db.prepare('SELECT * FROM auto_bookings WHERE user_id = ? ORDER BY id DESC').all(userId);
    }
    return db.prepare('SELECT * FROM auto_bookings WHERE user_id = ? AND gym_id = ? ORDER BY id DESC')
      .all(userId, resolvedGym);
  },
  // C5-3: everything this ONE user has queued, across every gym — competing-
  // booking detection compares across gyms, so this is deliberately not
  // gym-scoped. Scoped to the user, so it never sees anyone else's queue.
  getPendingAutoBookingsAllGyms(userId) {
    return db.prepare("SELECT * FROM auto_bookings WHERE user_id = ? AND status = 'pending' AND executed_at IS NULL ORDER BY id DESC").all(userId);
  },
  // Per-GYM quota, not per-account: a Psycle queue must not consume a JAB
  // allowance. (The limit itself lives in server.js — see layer G.)
  countPendingAutoBookings(userId, gymId = null) {
    const targetGym = resolveGymStrict(userId, gymId, 'countPendingAutoBookings');
    return db.prepare("SELECT COUNT(*) AS n FROM auto_bookings WHERE user_id = ? AND gym_id = ? AND status = 'pending' AND executed_at IS NULL")
      .get(userId, targetGym).n;
  },
  addAutoBooking(userId, eventId, className, instructorName, studioName, locationName, startAt, preferences, studioId = null, groupName = null, releaseAt = null, gymId = null, instructorImageUrl = null, durationMin = null) {
    const targetGym = resolveGymStrict(userId, gymId, 'addAutoBooking');
    const result = db.prepare(`
      INSERT INTO auto_bookings (user_id, gym_id, event_id, studio_id, class_name, instructor_name, instructor_image_url, studio_name, location_name, start_at, preferences, group_name, release_at, duration_min)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, targetGym, eventId, studioId, className, instructorName, instructorImageUrl, studioName, locationName, startAt, JSON.stringify(preferences), groupName, releaseAt, Number(durationMin) > 0 ? Number(durationMin) : null);
    return result.lastInsertRowid;
  },
  updateAutoBookingPreferences(id, userId, preferences) {
    db.prepare('UPDATE auto_bookings SET preferences = ? WHERE id = ? AND user_id = ?')
      .run(JSON.stringify(preferences), id, userId);
  },
  deleteAutoBooking(id, userId) {
    db.prepare('DELETE FROM auto_bookings WHERE id = ? AND user_id = ?').run(id, userId);
  },
  // Gym-scoped because event_id is a PROVIDER id — unique within a gym, not
  // across them. Without the predicate a JAB event could mark a Psycle queue
  // entry executed, and vice versa.
  //
  // `gymId` is an explicit argument, NOT resolveActiveGymId(userId), because the
  // only caller is the scheduler — background, no request context — processing a
  // row that may well belong to a gym other than the user's currently-selected
  // one. Resolving here would silently fail to mark exactly those rows. Pass
  // `booking.gym_id` from the row being executed.
  markAutoBookingExecuted(eventId, userId, gymId, status, message, executedAt, statusUpdates = {}) {
    if (!gymId) throw new Error('markAutoBookingExecuted requires the gym_id of the row being executed');
    db.prepare(`
      UPDATE auto_bookings
      SET status = ?, execution_message = ?, executed_at = ?
      WHERE event_id = ? AND user_id = ? AND gym_id = ? AND executed_at IS NULL
    `).run(status, message, executedAt, eventId, userId, gymId);
  },

  // Auto-upgrades
  getActiveAutoUpgrades() {
    return db.prepare("SELECT * FROM auto_upgrades WHERE status = 'active'").all();
  },
  // C5-1: monitors the poller paused because the balance was empty. Cross-user
  // background scanner, so — like getActiveAutoUpgrades — it must NOT filter by
  // gym; the caller routes per row via row.gym_id.
  getPausedNoCreditsAutoUpgrades() {
    return db.prepare("SELECT * FROM auto_upgrades WHERE status = 'paused_no_credits'").all();
  },
  // Monitors paused because the gym's polling switch is off. Background scanner:
  // no gym filter, the caller routes per row.
  getPausedDisabledAutoUpgrades() {
    return db.prepare("SELECT * FROM auto_upgrades WHERE status = 'paused_disabled'").all();
  },
  getUserAutoUpgrades(userId, gymId = undefined) {
    if (gymId === 'all') {
      return db.prepare('SELECT * FROM auto_upgrades WHERE user_id = ? ORDER BY id DESC').all(userId);
    }
    const resolvedGym = gymId !== undefined ? gymId : resolveActiveGymId(userId);
    if (!resolvedGym) {
      return db.prepare('SELECT * FROM auto_upgrades WHERE user_id = ? ORDER BY id DESC').all(userId);
    }
    return db.prepare('SELECT * FROM auto_upgrades WHERE user_id = ? AND gym_id = ? ORDER BY id DESC')
      .all(userId, resolvedGym);
  },
  countActiveAutoUpgrades(userId, gymId = null) {
    const targetGym = resolveGymStrict(userId, gymId, 'countActiveAutoUpgrades');
    return db.prepare("SELECT COUNT(*) AS n FROM auto_upgrades WHERE user_id = ? AND gym_id = ? AND status = 'active'")
      .get(userId, targetGym).n;
  },
  addAutoUpgrade(userId, eventId, bookingId, currentSlotId, className, instructorName, studioName, locationName, startAt, preferences, studioId = null, groupName = null, gymId = null) {
    const targetGym = resolveGymStrict(userId, gymId, 'addAutoUpgrade');
    const result = db.prepare(`
      INSERT INTO auto_upgrades (user_id, gym_id, event_id, studio_id, booking_id, current_slot_id, original_slot_id, class_name, instructor_name, studio_name, location_name, start_at, preferences, group_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, targetGym, eventId, studioId, bookingId, currentSlotId, currentSlotId, className, instructorName, studioName, locationName, startAt, JSON.stringify(preferences), groupName);
    return result.lastInsertRowid;
  },
  // All upgrade monitors for a user keyed by event_id — used by the calendar feed to
  // annotate confirmed classes with "(Auto-Upgrade is enabled -- originally bike X)".
  getUserAutoUpgradesByEvent(userId) {
    const rows = db.prepare('SELECT event_id, status, current_slot_id, original_slot_id, upgraded_slot_id FROM auto_upgrades WHERE user_id = ? AND gym_id = ?')
      .all(userId, resolveActiveGymId(userId));
    const map = {};
    for (const r of rows) map[String(r.event_id)] = r;
    return map;
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
    if (updates.bookingId !== undefined && updates.bookingId !== null) {
      // Cancel-then-rebook mints a new booking id; the monitor must follow it.
      setClause.push('booking_id = ?');
      params.push(updates.bookingId);
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
  // Re-point a monitor at the booking that now holds its seat (no status change).
  relinkAutoUpgradeBooking(id, userId, bookingId) {
    db.prepare('UPDATE auto_upgrades SET booking_id = ? WHERE id = ? AND user_id = ?').run(Number(bookingId), id, userId);
  },
  // A cancelled booking must end its monitor. Otherwise the poller sees a "better
  // seat" and books the class again for a member who just cancelled it.
  // gym_id is explicit: booking ids are unique only within a gym.
  stopAutoUpgradesForBooking(userId, gymId, bookingId, message = 'Booking was cancelled — monitoring stopped.') {
    if (bookingId == null || bookingId === '') return 0;
    const id = Number(bookingId);
    return db.prepare(`
      UPDATE auto_upgrades SET status = 'stopped', status_message = ?
      WHERE user_id = ? AND gym_id = ? AND status IN ('active', 'paused_no_credits', 'paused_disabled')
        AND (booking_id = ? OR new_booking_id = ?)
    `).run(message, userId, gymId, id, id).changes;
  },
  deleteAutoUpgrade(id, userId) {
    db.prepare('DELETE FROM auto_upgrades WHERE id = ? AND user_id = ?').run(id, userId);
  },

  // F-12 favourites (gym-neutral). Per-user accessors scope to ONE gym; `studio_id` is a provider
  // id, so an unscoped read would hand one gym's favourite to another's timetable. A multi-gym
  // account with no gym named is a call-site bug (resolveGymStrict throws), not a guess.
  listFavourites(userId, gymId = null) {
    const g = resolveGymStrict(userId, gymId, 'listFavourites');
    return db.prepare(`SELECT studio_id, day_of_week, start_time, class_name, discipline,
        instructor_name, studio_name, location_name FROM favourites
        WHERE user_id = ? AND gym_id = ? ORDER BY day_of_week, start_time, studio_id`).all(userId, g)
      .map((r) => {
        const o = { studioId: r.studio_id, dayOfWeek: r.day_of_week, startTime: r.start_time };
        if (r.class_name) o.className = r.class_name;
        if (r.discipline) o.discipline = r.discipline;
        if (r.instructor_name) o.instructorName = r.instructor_name;
        if (r.studio_name) o.studioName = r.studio_name;
        if (r.location_name) o.locationName = r.location_name;
        return o;
      });
  },
  countFavourites(userId, gymId = null) {
    const g = resolveGymStrict(userId, gymId, 'countFavourites');
    return db.prepare('SELECT COUNT(*) c FROM favourites WHERE user_id = ? AND gym_id = ?').get(userId, g).c;
  },
  // Idempotent: re-adding refreshes the labels and keeps the one row.
  addFavourite(userId, gymId, slot) {
    const g = resolveGymStrict(userId, gymId, 'addFavourite');
    db.prepare(`INSERT INTO favourites (user_id, gym_id, studio_id, day_of_week, start_time,
        class_name, discipline, instructor_name, studio_name, location_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, gym_id, studio_id, day_of_week, start_time) DO UPDATE SET
          class_name = COALESCE(excluded.class_name, class_name),
          discipline = COALESCE(excluded.discipline, discipline),
          instructor_name = COALESCE(excluded.instructor_name, instructor_name),
          studio_name = COALESCE(excluded.studio_name, studio_name),
          location_name = COALESCE(excluded.location_name, location_name)`)
      .run(userId, g, String(slot.studioId), slot.dayOfWeek, slot.startTime,
        slot.className || null, slot.discipline || null, slot.instructorName || null,
        slot.studioName || null, slot.locationName || null);
    return true;
  },
  removeFavourite(userId, gymId, slot) {
    const g = resolveGymStrict(userId, gymId, 'removeFavourite');
    return db.prepare(`DELETE FROM favourites WHERE user_id = ? AND gym_id = ? AND studio_id = ?
        AND day_of_week = ? AND start_time = ?`)
      .run(userId, g, String(slot.studioId), slot.dayOfWeek, slot.startTime).changes > 0;
  },

  // Studio Preferences
  // studio_id is a PROVIDER id, so these MUST be gym-scoped: Psycle studio 138
  // and a JAB studio 138 are different rooms with different floor plans, and an
  // unscoped read would hand one gym's spot map to the other's booking flow.
  getStudioPreferences(userId, gymId = null) {
    return db.prepare('SELECT * FROM studio_preferences WHERE user_id = ? AND gym_id = ?')
      .all(userId, gymId || resolveActiveGymId(userId));
  },
  // Resolve a single studio's live preferred spot map (the shared source of truth).
  // `studio_id` is a PROVIDER id, unique only inside one gym — pass the ROW's own
  // gym whenever you have one, exactly as the writer (setStudioPreference) does.
  getStudioPreference(userId, studioId, gymId = null) {
    if (studioId == null) return null;
    const row = db.prepare('SELECT preferences FROM studio_preferences WHERE user_id = ? AND gym_id = ? AND studio_id = ?')
      .get(userId, gymId || resolveActiveGymId(userId), studioId);
    return row ? JSON.parse(row.preferences) : null;
  },
  // `studio_id` is a PROVIDER id, unique only inside one gym, so a map saved
  // without a named gym lands on whichever one happens to resolve — writing one
  // gym's preferred spots over another's studio of the same id.
  setStudioPreference(userId, studioId, preferences, gymId = null) {
    const targetGym = resolveGymStrict(userId, gymId, 'setStudioPreference');
    const hasSelections = (preferences?.preferredSlots?.length || 0) > 0
      || (preferences?.preferredRows?.length || 0) > 0;
    if (!hasSelections) {
      db.prepare('DELETE FROM studio_preferences WHERE user_id = ? AND gym_id = ? AND studio_id = ?')
        .run(userId, targetGym, studioId);
      return;
    }
    db.prepare(`
      INSERT INTO studio_preferences (user_id, gym_id, studio_id, preferences, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, gym_id, studio_id) DO UPDATE SET preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
    `).run(userId, targetGym, studioId, JSON.stringify(preferences));
  },

  // Settings — one flat blob to every caller, two rows underneath (WP-D6).
  //
  // The blob mixes two scopes. `notifications` is about the person; a Psycle
  // `detectedBookingOffset` driving a JAB countdown is exactly the silent-wrong
  // failure this phase exists to remove. So the store splits, and the split is
  // invisible above this seam: get merges, set fans out, callers are unchanged.
  // `gymId` matters only for the gym-scoped half — pass a ROW's own gym
  // whenever you have one (a booking, an upgrade monitor). Background code with
  // no row to read it from (a cron sweep with no request context) falls back to
  // the deterministic default, same as every other still-ambient read.
  getUserSettings(userId, gymId = null) {
    const acct = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?').get(userId);
    const gym = db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?')
      .get(userId, gymId || resolveActiveGymId(userId));
    if (!acct && !gym) return null;
    return { ...parseJsonOr(acct && acct.preferences, {}), ...parseJsonOr(gym && gym.preferences, {}) };
  },
  // Export halves (C3-16): the account-scoped keys, and ONE gym's keys. Kept
  // separate because a backup that flattened them could not say which gym a
  // gym-scoped key belonged to, and restoring it then had to guess.
  getAccountSettings(userId) {
    const row = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?').get(userId);
    return parseJsonOr(row && row.preferences, {});
  },
  getGymSettings(userId, gymId) {
    const row = db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?').get(userId, gymId);
    return parseJsonOr(row && row.preferences, {});
  },
  splitSettingsByScope,
  /**
   * MERGE a patch of settings — only the keys the caller actually changed.
   *
   * This used to REPLACE both blobs wholesale, which is why every caller sent
   * the entire merged settings object back on every save. That made each save
   * gym-ambiguous: a request to change your theme also rewrote the gym half,
   * and nothing in it said which gym that half belonged to.
   *
   * Merging lets a caller send `{ theme: 'dark' }` and nothing else. The gym is
   * then only required when the patch actually touches a gym-scoped key — and
   * on a multi-gym account it is required rather than guessed.
   *
   * Note this means a key can be changed but never removed. Settings are set,
   * not deleted; removing one would need its own operation.
   */
  setUserSettings(userId, patch, gymId = null) {
    const { account, gym } = splitSettingsByScope(patch);
    const hasAccount = Object.keys(account).length > 0;
    const hasGym = Object.keys(gym).length > 0;
    // Resolved BEFORE the transaction: an unnamed gym must fail without having
    // written the account half, or a rejected save is still half-applied.
    const targetGym = hasGym ? resolveGymStrict(userId, gymId, 'setUserSettings') : null;

    const tx = db.transaction(() => {
      if (hasAccount) {
        const row = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?').get(userId);
        const merged = { ...parseJsonOr(row && row.preferences, {}), ...account };
        db.prepare(`
          INSERT INTO account_settings (user_id, preferences, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
        `).run(userId, JSON.stringify(merged));
      }
      if (hasGym) {
        const row = db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?')
          .get(userId, targetGym);
        const merged = { ...parseJsonOr(row && row.preferences, {}), ...gym };
        db.prepare(`
          INSERT INTO settings (user_id, gym_id, preferences, updated_at)
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id, gym_id) DO UPDATE SET preferences = excluded.preferences, updated_at = CURRENT_TIMESTAMP
        `).run(userId, targetGym, JSON.stringify(merged));
      }
    });
    tx();
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
  getUserIdsWithPushSubs() {
    return db.prepare('SELECT DISTINCT user_id FROM push_subscriptions').all().map(r => r.user_id);
  },

  // Booking cache (for cancellation reminders — no per-minute API polling)
  // The DELETE is gym-scoped too, and that matters more than the INSERT: an
  // unscoped "replace this user's cache" would wipe the OTHER gym's bookings
  // every time one gym synced, so whichever gym synced last would be the only
  // one with reminders.
  /**
   * Replace the reminder cache, filing each booking under ITS OWN gym.
   *
   * This used to resolve one gym and write every row under it. The client syncs
   * the MERGED list (one call, every linked gym), so on a two-gym account every
   * JAB booking was stored as a Psycle row while the other gym's rows were
   * never refreshed — they just went stale and kept firing reminders, because
   * the cancellation scanner reads every row and routes by `gym_id`.
   *
   * @param scopeGymIds the gyms this call is AUTHORITATIVE for. They are cleared
   *   even when the payload has no rows for them, which is how the last booking
   *   at a gym actually disappears. Defaults to just the gyms present in the
   *   payload, so a single-gym caller cannot wipe another gym's cache.
   */
  replaceBookingCache(userId, bookings, scopeGymIds = null) {
    const list = Array.isArray(bookings) ? bookings : [];
    const rowsByGym = new Map();
    for (const b of list) {
      if (b.bookingId == null || !b.startAt) continue;
      const gym = b.gymId || resolveGymStrict(userId, null, 'replaceBookingCache');
      if (!rowsByGym.has(gym)) rowsByGym.set(gym, []);
      rowsByGym.get(gym).push(b);
    }
    const scope = (scopeGymIds && scopeGymIds.length)
      ? [...new Set(scopeGymIds)]
      : [...rowsByGym.keys()];

    const del = db.prepare('DELETE FROM booking_cache WHERE user_id = ? AND gym_id = ?');
    const ins = db.prepare(`
      INSERT OR REPLACE INTO booking_cache
        (user_id, gym_id, booking_id, event_id, start_at, class_name, group_name, instructor_name, studio_name, location_name, slot_label, duration_min, location_address, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const tx = db.transaction((uid) => {
      for (const gym of scope) del.run(uid, gym);
      for (const [gym, rows] of rowsByGym) {
        if (!scope.includes(gym)) continue; // not ours to write
        for (const b of rows) {
          ins.run(uid, gym, b.bookingId, b.eventId ?? null, b.startAt, b.className ?? null, b.groupName ?? null,
            b.instructorName ?? null, b.studioName ?? null, b.locationName ?? null, String(b.slotLabel ?? ''), b.durationMin ?? null, b.locationAddress ?? null);
        }
      }
    });
    tx(userId);
  },

  // A guest reservation is linked to its member reservation, rather than being
  // a second self-attendee. The provider does not expose that relationship in
  // its list response, so retain it locally for safe cancellation. Every method
  // is idempotent: retries and provider/list recovery can safely re-record or
  // remove the same edge.
  upsertGuestBookingGroup(userId, gymId, eventId, primaryBookingId, guestBookingId) {
    db.prepare(`
      INSERT INTO guest_booking_groups
        (user_id, gym_id, event_id, primary_booking_id, guest_booking_id, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, gym_id, guest_booking_id) DO UPDATE SET
        event_id = excluded.event_id,
        primary_booking_id = excluded.primary_booking_id,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, gymId, String(eventId), String(primaryBookingId), String(guestBookingId));
  },
  getGuestBookingGroupByMember(userId, gymId, bookingId) {
    return db.prepare(`
      SELECT * FROM guest_booking_groups
      WHERE user_id = ? AND gym_id = ?
        AND (primary_booking_id = ? OR guest_booking_id = ?)
      ORDER BY id ASC
    `).all(userId, gymId, String(bookingId), String(bookingId));
  },
  getGuestBookingIdsForPrimary(userId, gymId, primaryBookingId) {
    return db.prepare(`
      SELECT guest_booking_id FROM guest_booking_groups
      WHERE user_id = ? AND gym_id = ? AND primary_booking_id = ?
      ORDER BY id ASC
    `).all(userId, gymId, String(primaryBookingId)).map((row) => String(row.guest_booking_id));
  },
  deleteGuestBookingGroupForGuest(userId, gymId, guestBookingId) {
    db.prepare('DELETE FROM guest_booking_groups WHERE user_id = ? AND gym_id = ? AND guest_booking_id = ?')
      .run(userId, gymId, String(guestBookingId));
  },
  deleteGuestBookingGroupsForPrimary(userId, gymId, primaryBookingId) {
    db.prepare('DELETE FROM guest_booking_groups WHERE user_id = ? AND gym_id = ? AND primary_booking_id = ?')
      .run(userId, gymId, String(primaryBookingId));
  },
  // Cross-user background scanner (cancellation reminders) — deliberately NOT
  // gym-filtered. Rows carry gym_id; the caller routes per row.
  getAllBookingCache() {
    return db.prepare('SELECT * FROM booking_cache').all();
  },
  // C5-3: this user's cached bookings across every gym (see getPendingAutoBookingsAllGyms).
  getBookingCacheAllGyms(userId) {
    return db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND start_at >= ?')
      .all(userId, new Date(Date.now() - 864e5).toISOString());
  },
  getBookingCacheForUser(userId) {
    return db.prepare('SELECT * FROM booking_cache WHERE user_id = ? AND gym_id = ?')
      .all(userId, resolveActiveGymId(userId));
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

  // Admin queries (WP-D3: priority/display_name/profile_synced_at/session now come
  // from user_gyms, scoped to each user's resolved gym — currently always the
  // default gym, so this is a straight LEFT JOIN with no behavior change).
  // C3-7: this used to LEFT JOIN user_gyms on the LITERAL DEFAULT_GYM_ID, so a
  // JAB-only account (no psycle-london link at all) always missed the join and
  // showed up with a blank display_name, priority defaulting to 100, and no
  // session — i.e. the admin list only ever showed Psycle data. Each user's
  // display_name/priority/profile_synced_at/session now come from THEIR OWN
  // resolved gym (resolveActiveGymId — sole link, else the default gym, else
  // their first link; same fallback chain used everywhere else with no request
  // context), not a hardcoded one. `active_gym_id` is exposed so the admin UI
  // can label which gym a row's summary fields belong to.
  getAllUsers() {
    const rows = db.prepare(`
      SELECT
        u.id, u.email, u.created_at, u.last_seen_at,
        u.display_name AS legacy_display_name,
        u.priority AS legacy_priority,
        u.profile_synced_at AS legacy_profile_synced_at,
        (SELECT COUNT(*) FROM auto_bookings WHERE user_id = u.id AND status = 'pending' AND executed_at IS NULL) AS pending_bookings,
        (SELECT COUNT(*) FROM auto_upgrades WHERE user_id = u.id AND status = 'active') AS active_upgrades,
        (SELECT COUNT(*) FROM user_gyms WHERE user_id = u.id) AS gym_count
      FROM users u
    `).all();

    const withGym = rows.map((r) => {
      const gymId = resolveActiveGymId(r.id);
      const ug = db.prepare(
        'SELECT display_name, priority, profile_synced_at, session_json FROM user_gyms WHERE user_id = ? AND gym_id = ?'
      ).get(r.id, gymId);
      let jwtExpiresAt = null;
      if (ug && ug.session_json) { try { jwtExpiresAt = JSON.parse(ug.session_json).expiresAt || null; } catch (_) {} }
      return {
        id: r.id,
        email: r.email,
        created_at: r.created_at,
        last_seen_at: r.last_seen_at,
        display_name: (ug ? ug.display_name : null) ?? r.legacy_display_name,
        priority: (ug ? ug.priority : null) ?? r.legacy_priority ?? 100,
        profile_synced_at: (ug ? ug.profile_synced_at : null) ?? r.legacy_profile_synced_at,
        pending_bookings: r.pending_bookings,
        active_upgrades: r.active_upgrades,
        gym_count: r.gym_count,
        active_gym_id: gymId,
        // C6-4: EVERY linked gym with background relogin trouble, not just the
        // resolved one — a JAB failure must show on an account whose summary
        // row reads Psycle.
        relogin_issues: db.prepare(`
          SELECT ug.gym_id, g.name AS gym_name, ug.relogin_failures AS failures,
                 ug.relogin_suspended AS suspended, ug.last_relogin_failure_at
          FROM user_gyms ug JOIN gyms g ON g.id = ug.gym_id
          WHERE ug.user_id = ? AND ug.relogin_failures > 0
          ORDER BY ug.gym_id`).all(r.id).map((i) => ({ ...i, suspended: !!i.suspended })),
        jwt_expires_at: jwtExpiresAt,
      };
    });

    withGym.sort((a, b) => (a.priority - b.priority) || (new Date(a.created_at) - new Date(b.created_at)));
    return withGym;
  },
  // Full per-user bundle for the admin detail drawer. Parses cached profile + all
  // per-user JSON blobs so the route layer can shape the response.
  getUserDetail(userId) {
    const gymId = resolveActiveGymId(userId);
    const base = db.prepare('SELECT id, email, created_at, last_seen_at FROM users WHERE id = ?').get(userId);
    if (!base) return null;
    const ug = db.prepare('SELECT * FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(userId, gymId);
    let jwtExpiresAt = null;
    if (ug && ug.session_json) { try { jwtExpiresAt = JSON.parse(ug.session_json).expiresAt || null; } catch (_) {} }
    const user = {
      ...base,
      display_name: ug ? ug.display_name : null,
      priority: ug ? ug.priority : 100,
      profile_synced_at: ug ? ug.profile_synced_at : null,
      jwt_expires_at: jwtExpiresAt,
    };

    let profile = null;
    const profileJson = ug ? ug.profile_json : null;
    if (profileJson) { try { profile = JSON.parse(profileJson); } catch (_) {} }

    // Merged view (WP-D6): the admin drawer should show what the user actually
    // has in effect for this gym — account-scoped keys plus this gym's own.
    let settings = null;
    const sRow = db.prepare('SELECT preferences FROM settings WHERE user_id = ? AND gym_id = ?').get(userId, gymId);
    const aRow = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?').get(userId);
    if (sRow || aRow) {
      settings = { ...parseJsonOr(aRow && aRow.preferences, {}), ...parseJsonOr(sRow && sRow.preferences, {}) };
    }

    const parsePrefs = (rows) => rows.map(r => {
      let preferences = {};
      try { preferences = JSON.parse(r.preferences || '{}'); } catch (_) {}
      return { ...r, preferences };
    });

    return {
      user,
      profile,
      settings,
      autoBookings: parsePrefs(db.prepare('SELECT * FROM auto_bookings WHERE user_id = ? ORDER BY start_at ASC, id DESC').all(userId)),
      autoUpgrades: parsePrefs(db.prepare('SELECT * FROM auto_upgrades WHERE user_id = ? ORDER BY start_at ASC, id DESC').all(userId)),
      studioPreferences: parsePrefs(db.prepare('SELECT * FROM studio_preferences WHERE user_id = ? ORDER BY studio_id ASC').all(userId)),
      bookings: db.prepare('SELECT * FROM booking_cache WHERE user_id = ? ORDER BY start_at ASC').all(userId),
      gyms: this.getUserGymsPublic(userId), // WP-D4: linked gyms for the admin panel
    };
  },
  // Build a { studio_id: studio_name } map purely from DB rows (no API call).
  // Scans auto_bookings + auto_upgrades for rows that have both a studio_id and
  // a non-empty studio_name. Used as a fallback for the admin detail view's
  // studioNames field when live provider metadata cannot be fetched. Studio ids
  // are only unique within a gym, so callers should pass their selected gym.
  getStudioNameMap(gymId) {
    const gymFilter = gymId ? ' AND gym_id = ?' : '';
    const params = gymId ? [gymId] : [];
    const rows = db.prepare(`
      SELECT studio_id, MAX(studio_name) AS studio_name FROM (
        SELECT studio_id, studio_name FROM auto_bookings WHERE studio_id IS NOT NULL AND studio_name IS NOT NULL AND studio_name != ''${gymFilter}
        UNION ALL
        SELECT studio_id, studio_name FROM auto_upgrades WHERE studio_id IS NOT NULL AND studio_name IS NOT NULL AND studio_name != ''${gymFilter}
      ) GROUP BY studio_id
    `).all(...params, ...params);
    const map = {};
    for (const row of rows) {
      if (row.studio_id != null && row.studio_name) map[String(row.studio_id)] = row.studio_name;
    }
    return map;
  },
  // Priority is genuinely per-gym-registration — the scheduler joins
  // `user_gyms.priority` for a booking's OWN gym (WP-D3) — but the admin panel
  // has one "VIP" control per user, no per-gym picker. Defaulting to
  // resolveActiveGymId silently left every OTHER linked gym at the old
  // priority, so a user marked VIP kept queuing at default priority everywhere
  // except whichever gym happened to be active. Applying to every linked gym
  // when no gym is named matches what the single control actually promises.
  setUserPriority(userId, priority, gymId = null) {
    db.prepare('UPDATE users SET priority = ? WHERE id = ?').run(priority, userId);
    if (gymId) {
      this.upsertUserGym(userId, gymId, { priority });
    } else {
      for (const g of this.getUserGyms(userId)) {
        this.upsertUserGym(userId, g.gym_id, { priority });
      }
    }
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
  },

  // ─── Calendar feed (WP-D3: token lives on user_gyms; users.calendar_token is a
  // dual-written vestige for defense-in-depth during the transition) ──────────
  // The feed is ACCOUNT-level: one token, one URL, every linked gym's classes.
  // `users.calendar_token` is the source of truth; the per-gym
  // `user_gyms.calendar_token` is read only as a migration fallback, so anyone
  // already subscribed to a per-gym URL keeps working and is promoted in place
  // the first time it is read.
  getCalendarToken(userId) {
    const u = db.prepare('SELECT calendar_token FROM users WHERE id = ?').get(userId);
    if (u && u.calendar_token) return u.calendar_token;
    const ug = db.prepare('SELECT calendar_token FROM user_gyms WHERE user_id = ? AND calendar_token IS NOT NULL ORDER BY gym_id LIMIT 1').get(userId);
    if (!ug || !ug.calendar_token) return null;
    // Promote the existing per-gym token to the account so the URL the user has
    // already added to their calendar app keeps resolving.
    db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(ug.calendar_token, userId);
    return ug.calendar_token;
  },
  setCalendarToken(userId, token) {
    db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').run(token, userId);
    // Clear every per-gym token: leaving them live would keep old single-gym
    // feed URLs serving, which is exactly the leak a rotation is meant to close.
    db.prepare('UPDATE user_gyms SET calendar_token = NULL WHERE user_id = ?').run(userId);
  },
  getUserByCalendarToken(token) {
    if (!token) return null;
    const user = db.prepare('SELECT * FROM users WHERE calendar_token = ?').get(token);
    if (user) return mergeUserWithGym(user, resolveActiveGymId(user.id));
    // Migration fallback: a token issued before the feed became account-level.
    const ug = db.prepare('SELECT * FROM user_gyms WHERE calendar_token = ?').get(token);
    if (!ug) return null;
    const legacy = db.prepare('SELECT * FROM users WHERE id = ?').get(ug.user_id);
    return mergeUserWithGym(legacy, ug.gym_id);
  },
  // Users who have turned the calendar feed on (account token + calendar.enabled).
  getCalendarEnabledUserIds() {
    const ids = [];
    const rows = db.prepare('SELECT id FROM users WHERE calendar_token IS NOT NULL').all();
    for (const r of rows) {
      try {
        const aRow = db.prepare('SELECT preferences FROM account_settings WHERE user_id = ?').get(r.id);
        const prefs = aRow ? JSON.parse(aRow.preferences) : {};
        if (prefs.calendar && prefs.calendar.enabled) ids.push(r.id);
      } catch (_) {}
    }
    return ids;
  },

  // Waitlist cache (one row per waitlisted class)
  // Gym-scoped DELETE for the same reason as replaceBookingCache: an unscoped
  // wipe would drop the other gym's waitlists on every sync.
  // scopeGymIds: if provided, only these gyms' rows are cleared/replaced; defaults
  // to the active gym for backward compatibility (legacy callers), or to the gyms
  // present in the payload if scopeGymIds is explicitly an array.
  replaceWaitlistCache(userId, list, scopeGymIds = null) {
    const allList = Array.isArray(list) ? list : [];
    const rowsByGym = new Map();
    for (const w of allList) {
      if (w.eventId == null || !w.startAt) continue;
      const gym = w.gymId || resolveActiveGymId(userId);
      if (!rowsByGym.has(gym)) rowsByGym.set(gym, []);
      rowsByGym.get(gym).push(w);
    }
    // If scopeGymIds not provided, use active gym for backward compatibility.
    const scope = (scopeGymIds && scopeGymIds.length)
      ? [...new Set(scopeGymIds)]
      : [resolveActiveGymId(userId)];

    const del = db.prepare('DELETE FROM waitlist_cache WHERE user_id = ? AND gym_id = ?');
    const ins = db.prepare(`
      INSERT OR REPLACE INTO waitlist_cache
        (user_id, gym_id, event_id, start_at, class_name, group_name, instructor_name, studio_name, location_name, studio_id, location_address, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);
    const tx = db.transaction((uid) => {
      for (const gym of scope) del.run(uid, gym);
      for (const [gym, rows] of rowsByGym) {
        if (!scope.includes(gym)) continue; // not ours to write
        for (const w of rows) {
          ins.run(uid, gym, w.eventId, w.startAt, w.className ?? null, w.groupName ?? null,
            w.instructorName ?? null, w.studioName ?? null, w.locationName ?? null, w.studioId ?? null, w.locationAddress ?? null);
        }
      }
    });
    tx(userId);
  },
  getWaitlistCacheForUser(userId) {
    return db.prepare('SELECT * FROM waitlist_cache WHERE user_id = ? AND gym_id = ?')
      .all(userId, resolveActiveGymId(userId));
  },

  // calendar_classes — the persistent store backing the feed
  // `gymId` omitted = EVERY linked gym, which is what the account-level feed
  // serializes. Pass one explicitly only when reconciling a single gym's rows.
  getCalendarClasses(userId, gymId) {
    if (gymId) {
      return db.prepare('SELECT * FROM calendar_classes WHERE user_id = ? AND gym_id = ? ORDER BY start_at ASC')
        .all(userId, gymId);
    }
    return db.prepare('SELECT * FROM calendar_classes WHERE user_id = ? ORDER BY start_at ASC').all(userId);
  },
  // Upsert one class; bumps sequence when the content hash changes so calendar
  // clients re-render the event in place.
  upsertCalendarClass(userId, c, explicitGymId) {
    // Explicit gym, because the feed writes rows for gyms the user is not
    // currently "on" — resolving the active gym here would file every gym's
    // classes under whichever one happened to be selected.
    const gymId = explicitGymId || c.gymId || resolveActiveGymId(userId);
    const existing = db.prepare('SELECT sequence, content_hash FROM calendar_classes WHERE user_id = ? AND gym_id = ? AND event_id = ?')
      .get(userId, gymId, c.eventId);
    let sequence = 0;
    if (existing) {
      sequence = existing.sequence || 0;
      if (existing.content_hash !== c.contentHash) sequence += 1;
    }
    db.prepare(`
      INSERT INTO calendar_classes
        (user_id, gym_id, event_id, start_at, duration_min, class_name, group_name, instructor_name,
         studio_name, location_name, location_address, slot_label, original_slot_label, status, upgrade_note, sequence, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, gym_id, event_id) DO UPDATE SET
        start_at = excluded.start_at, duration_min = excluded.duration_min,
        class_name = excluded.class_name, group_name = excluded.group_name,
        instructor_name = excluded.instructor_name, studio_name = excluded.studio_name,
        location_name = excluded.location_name, location_address = excluded.location_address,
        slot_label = excluded.slot_label,
        original_slot_label = COALESCE(calendar_classes.original_slot_label, excluded.original_slot_label),
        status = excluded.status, upgrade_note = excluded.upgrade_note,
        sequence = excluded.sequence, content_hash = excluded.content_hash,
        updated_at = CURRENT_TIMESTAMP
    `).run(userId, gymId, c.eventId, c.startAt, c.durationMin ?? null, c.className ?? null, c.groupName ?? null,
      c.instructorName ?? null, c.studioName ?? null, c.locationName ?? null, c.locationAddress ?? null, c.slotLabel ?? null,
      c.originalSlotLabel ?? null, c.status, c.upgradeNote ?? null, sequence, c.contentHash);
  },
  // Delete future classes (start_at > nowISO) whose event_id is not in keepEventIds —
  // i.e. they were cancelled/unbooked. Past classes are never removed here (history).
  reconcileFutureCalendarClasses(userId, nowISO, keepEventIds, explicitGymId) {
    const gymId = explicitGymId || resolveActiveGymId(userId);
    const future = db.prepare('SELECT event_id FROM calendar_classes WHERE user_id = ? AND gym_id = ? AND start_at > ?').all(userId, gymId, nowISO);
    const keep = new Set(keepEventIds.map(String));
    const del = db.prepare('DELETE FROM calendar_classes WHERE user_id = ? AND gym_id = ? AND event_id = ?');
    const tx = db.transaction(() => {
      for (const r of future) {
        if (!keep.has(String(r.event_id))) del.run(userId, gymId, r.event_id);
      }
    });
    tx();
  },
  // Keep at most `max` most-recent past classes per user (by start_at), drop older history.
  // Caps the account's TOTAL retained history, not each gym's separately — the
  // user sees one calendar, so one budget.
  capPastCalendarClasses(userId, nowISO, max) {
    const past = db.prepare('SELECT id FROM calendar_classes WHERE user_id = ? AND start_at <= ? ORDER BY start_at DESC')
      .all(userId, nowISO);
    if (past.length <= max) return;
    const toDrop = past.slice(max).map(r => r.id);
    const del = db.prepare('DELETE FROM calendar_classes WHERE id = ?');
    const tx = db.transaction(() => { for (const id of toDrop) del.run(id); });
    tx();
  },

  // calendar_snapshots — the published ICS
  getCalendarSnapshot(userId) {
    return db.prepare('SELECT * FROM calendar_snapshots WHERE user_id = ?').get(userId);
  },
  saveCalendarSnapshot(userId, ics, etag, classCount) {
    db.prepare(`
      INSERT INTO calendar_snapshots (user_id, ics, etag, class_count, generated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET ics = excluded.ics, etag = excluded.etag,
        class_count = excluded.class_count, generated_at = CURRENT_TIMESTAMP
    `).run(userId, ics, etag, classCount);
  },

  // ─── Modular multi-gym (WP-D1 schema, now the real source of truth for auth/
  // session data as of WP-D3 — see mergeUserWithGym / resolveActiveGymId above) ──
  getGyms() {
    return db.prepare('SELECT * FROM gyms ORDER BY name ASC').all();
  },
  getGym(gymId) {
    return db.prepare('SELECT * FROM gyms WHERE id = ?').get(gymId);
  },
  getUserGyms(userId) {
    return db.prepare('SELECT * FROM user_gyms WHERE user_id = ? ORDER BY gym_id ASC').all(userId);
  },
  // Gym links with secrets stripped (no encrypted_password/session_json) and gym
  // metadata joined in — safe to serialize in an API response. Used by the admin
  // panel (WP-D4) and, eventually, a user-facing "linked gyms" view (Phase 5).
  getUserGymsPublic(userId) {
    return db.prepare(`
      SELECT ug.gym_id, g.name AS gym_name, g.provider, g.enabled AS gym_enabled,
             ug.display_name,
             ug.gym_email, ug.status, ug.priority,
             (ug.calendar_token IS NOT NULL) AS calendar_enabled,
             ug.created_at, ug.updated_at, ug.last_authenticated_at,
             ug.relogin_failures, ug.relogin_rejections, ug.relogin_suspended,
             ug.last_relogin_failure_at, ug.last_relogin_error
      FROM user_gyms ug
      JOIN gyms g ON g.id = ug.gym_id
      WHERE ug.user_id = ?
      ORDER BY ug.gym_id ASC
    `).all(userId);
  },
  getUserGym(userId, gymId) {
    return db.prepare('SELECT * FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(userId, gymId);
  },
  // Flag a link's health (WP-D7): 'active' | 'needs_relogin' | 'disabled'.
  // Set to 'needs_relogin' when session renewal fails, so the UI can prompt for a
  // re-link instead of the user meeting silent empty screens. The link itself is
  // never removed on a renewal failure — a transient provider outage must not
  // cost someone their queue, spot maps and calendar token (Decision D4).
  setUserGymStatus(userId, gymId, status) {
    db.prepare('UPDATE user_gyms SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND gym_id = ?')
      .run(status, userId, gymId);
  },
  // C6-4: record one failed background renewal. `rejected` = the gym refused the
  // credential (as opposed to an outage/timeout); only rejections count toward
  // suspension, so a provider outage can never lock a member out of retries.
  // Returns the post-update counters.
  recordReloginFailure(userId, gymId, { rejected = false, error = '', maxRejections = 3 } = {}) {
    db.prepare(`UPDATE user_gyms SET
        relogin_failures = relogin_failures + 1,
        relogin_rejections = CASE WHEN ? THEN relogin_rejections + 1 ELSE relogin_rejections END,
        last_relogin_failure_at = ?, last_relogin_error = ?, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND gym_id = ?`)
      .run(rejected ? 1 : 0, new Date().toISOString(), String(error || '').slice(0, 300), userId, gymId);
    db.prepare('UPDATE user_gyms SET relogin_suspended = 1 WHERE user_id = ? AND gym_id = ? AND relogin_rejections >= ?')
      .run(userId, gymId, maxRejections);
    return db.prepare('SELECT relogin_failures, relogin_rejections, relogin_suspended FROM user_gyms WHERE user_id = ? AND gym_id = ?')
      .get(userId, gymId);
  },
  // Reset after a successful renewal, a re-link with fresh credentials, or an admin credential reset.
  clearReloginFailures(userId, gymId) {
    db.prepare(`UPDATE user_gyms SET relogin_failures = 0, relogin_rejections = 0, relogin_suspended = 0,
        last_relogin_failure_at = NULL, last_relogin_error = NULL
      WHERE user_id = ? AND gym_id = ? AND (relogin_failures != 0 OR relogin_rejections != 0 OR relogin_suspended != 0
        OR last_relogin_failure_at IS NOT NULL OR last_relogin_error IS NOT NULL)`).run(userId, gymId);
  },
  // Generic upsert for the (user, gym) link — pass any subset of the mutable
  // columns. Used by WP-D3 (account bootstrap + gym linking) and WP-D4 (query
  // rewiring) once application code starts writing through this table.
  upsertUserGym(userId, gymId, fields = {}) {
    const existing = this.getUserGym(userId, gymId);
    const merged = { gym_email: null, encrypted_password: null, session_json: null, display_name: null, profile_json: null,
      profile_synced_at: null, calendar_token: null, priority: 100, status: 'active', last_authenticated_at: null,
      ...existing, ...fields };
    // U1-9: `last_authenticated_at` MUST be in both column lists below. It was in
    // neither for months, so every caller that passed it (setGymSession,
    // linkGymAccount) had it silently dropped and Settings always read "Not recorded".
    db.prepare(`
      INSERT INTO user_gyms
        (user_id, gym_id, gym_email, encrypted_password, session_json, display_name, profile_json, profile_synced_at, calendar_token, priority, status, last_authenticated_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, gym_id) DO UPDATE SET
        gym_email = excluded.gym_email,
        encrypted_password = excluded.encrypted_password, session_json = excluded.session_json,
        display_name = excluded.display_name, profile_json = excluded.profile_json,
        profile_synced_at = excluded.profile_synced_at, calendar_token = excluded.calendar_token,
        priority = excluded.priority, status = excluded.status,
        last_authenticated_at = excluded.last_authenticated_at, updated_at = CURRENT_TIMESTAMP
    `).run(userId, gymId, merged.gym_email, merged.encrypted_password, merged.session_json, merged.display_name,
      merged.profile_json, merged.profile_synced_at, merged.calendar_token, merged.priority, merged.status,
      merged.last_authenticated_at);
  },
  // Explicit "link a second gym to this account" entry point (WP-D3 AC). Thin
  // wrapper over upsertUserGym — not yet exposed via any route (that's Phase 5's
  // client gym picker); exists so the capability can be tested/used standalone.
  // `credentials` is optional: { encryptedPassword } for password-based providers.
  linkGym(userId, gymId, credentials = {}) {
    if (!this.getGym(gymId)) throw new Error(`Cannot link unknown gym "${gymId}".`);
    this.upsertUserGym(userId, gymId, {
      encrypted_password: credentials.encryptedPassword ?? null,
      priority: 200,
    });
    return this.getUserGym(userId, gymId);
  },
  // --- Sweat Assistant's own credential (Decision D4) ------------------------
  //
  // scrypt with a per-user random salt. Stored as `scrypt$N$r$p$salt$hash`, all
  // hex, so the work factor travels with the hash and can be raised later without
  // invalidating existing ones. Verification is constant-time.
  setAccountPassword(userId, password) {
    if (!password || String(password).length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  },

  hasAccountPassword(userId) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    return !!(row && row.password_hash);
  },

  verifyAccountPassword(userId, password) {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!row || !row.password_hash || !password) return false;
    return verifyPassword(password, row.password_hash);
  },

  // Remove a (user, gym) link and everything scoped to it. The account row itself
  // is untouched (Decision D4). If the unlinked gym was the active one,
  // resolveActiveGymId's fallback chain takes over — active_gym_id is cleared
  // here anyway so the stale value doesn't linger in the row.
  unlinkGym(userId, gymId) {
    const tx = db.transaction(() => {
      for (const table of ['auto_bookings', 'auto_upgrades', 'studio_preferences', 'settings',
                           'booking_cache', 'waitlist_cache', 'calendar_classes', 'guest_booking_groups',
                           'class_history', 'class_history_sync', 'favourites']) {
        try { db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND gym_id = ?`).run(userId, gymId); }
        catch (_) { /* table may predate its gym_id column on an old DB — skip */ }
      }
      db.prepare('DELETE FROM user_gyms WHERE user_id = ? AND gym_id = ?').run(userId, gymId);
    });
    tx();
  },

  // Is this account linked to this gym? The authorisation check behind every
  // gym switch and every `x-gym-id` header — a user must never be able to select
  // a gym they have not linked, since that would resolve another account's
  // session/credentials path.
  isGymLinked(userId, gymId) {
    if (!gymId) return false;
    return !!db.prepare('SELECT 1 FROM user_gyms WHERE user_id = ? AND gym_id = ?').get(userId, gymId);
  },

  // Exported so WP-N1's normalized routes resolve gym context through the same
  // seam as everything else in db.js, rather than hardcoding DEFAULT_GYM_ID a
  // second time.
  resolveActiveGymId,
  // Explicit gym, else request gym, else the sole linked gym; throws for a multi-gym
  // account that names none. Exported for routes-normalized (C3-28).
  resolveGymStrict,
  // Establish the per-request active gym (see the note on resolveActiveGymId).
  // The caller must have verified the link first — auth.js's middleware does.
  runWithGymContext,
};
