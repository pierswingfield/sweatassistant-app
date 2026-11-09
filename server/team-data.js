// T-2: read-only loader for the Team projection (PLAN-teams.md §7.2). It reads stored
// rows and never calls a gym: booking_cache (server-synced rows only), waitlist_cache,
// pending auto_bookings, class_history (the last 31 days) and booking_sync_state, plus
// each member's gym links. The rows go to server/team-projection.js, which decides
// what a viewer may see. Writers of these tables stay where they are (booking-sync.js,
// class-history.js, the auto-book routes); this module only selects.
//
// Cross-user by design (a Team spans accounts), but always scoped to the user ids the
// caller passes, which teams.js supplies (the members of a Team the viewer is in).

const { db } = require('./db');

const HISTORY_WINDOW_MS = 31 * 24 * 3600 * 1000; // RECENT_DAYS plus the start of this month's edge

function placeholders(n) { return Array.from({ length: n }, () => '?').join(', '); }

function groupBy(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.user_id)) out.set(r.user_id, []);
    out.get(r.user_id).push(r);
  }
  return out;
}

/**
 * Rows for each user id, ready for projectTeam's member input.
 * @returns {Map<number, {links, bookings, waitlists, queue, history, syncState}>}
 */
function rowsForUsers(userIds, { now = Date.now() } = {}) {
  const ids = [...new Set((userIds || []).map(Number).filter(Number.isFinite))];
  const out = new Map(ids.map((id) => [id, { links: [], bookings: [], waitlists: [], queue: [], history: [], syncState: [] }]));
  if (!ids.length) return out;
  const ph = placeholders(ids.length);
  const sinceTs = now - HISTORY_WINDOW_MS;
  const sources = {
    links: db.prepare(`SELECT user_id, gym_id, account_enabled, status FROM user_gyms WHERE user_id IN (${ph})`).all(...ids),
    // Only rows the server's own sync wrote: a client push alone never reaches a Team.
    bookings: db.prepare(`SELECT user_id, gym_id, booking_id, event_id, start_at, class_name, group_name, instructor_name,
      studio_name, location_name, slot_label, duration_min, origin, missing_since FROM booking_cache
      WHERE origin = 'server' AND user_id IN (${ph})`).all(...ids),
    waitlists: db.prepare(`SELECT user_id, gym_id, event_id, start_at, class_name, group_name, instructor_name,
      studio_name, location_name FROM waitlist_cache WHERE user_id IN (${ph})`).all(...ids),
    queue: db.prepare(`SELECT user_id, gym_id, event_id, start_at, class_name, group_name, instructor_name,
      studio_name, location_name, duration_min, status, executed_at FROM auto_bookings
      WHERE status = 'pending' AND executed_at IS NULL AND user_id IN (${ph})`).all(...ids),
    history: db.prepare(`SELECT user_id, gym_id, booking_id, event_id, status, start_at, start_ts, time_zone, duration_min,
      class_name, discipline, instructor_id, instructor_name, studio_name, location_name FROM class_history
      WHERE start_ts >= ? AND user_id IN (${ph})`).all(sinceTs, ...ids),
    syncState: db.prepare(`SELECT user_id, gym_id, last_synced_at FROM booking_sync_state WHERE user_id IN (${ph})`).all(...ids),
  };
  for (const [key, rows] of Object.entries(sources)) {
    for (const [uid, list] of groupBy(rows)) if (out.has(uid)) out.get(uid)[key] = list;
  }
  return out;
}

/** Every gym the viewer has linked, enabled or paused (§4: paused counts as linked). */
function linkedGymIds(userId, { available = false } = {}) {
  return db.prepare(`SELECT gym_id FROM user_gyms WHERE user_id = ? ${available ? "AND status NOT IN ('needs_relogin','syncing')" : ''}`).all(userId).map((r) => r.gym_id);
}

module.exports = { rowsForUsers, linkedGymIds, HISTORY_WINDOW_MS };
