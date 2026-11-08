// class history store (F-10-0).
//
// A MINIMAL per-user history of past classes, one row per (user, gym, provider
// booking id), NORMALIZED fields only, shaped so C8-1's booking_ledger can adopt
// it. Everything that reads or writes the `class_history` / `class_history_sync`
// tables goes through THIS module, so storage can change (e.g. to aggregates
// only) without touching callers. Interface:
//
//   syncUserGym(userId, gymId, {full})   pull + upsert + record last-synced
//   ensureHistory(userId, gymId)         lazy backfill (first load) + stale refresh
//   syncStale({maxAgeMs})                background scan, all users, all gyms
//   listHistory(userId, gymId, opts)     stored rows (camelCase, no raw)
//   topInstructors(userId, gymId, opts)  counts per instructor, last N days
//   getSyncState(userId, gymId)
//
// Gym rules (AGENTS.md): gym_id is NOT NULL and part of every key; the pull uses
// the ROW's gym session (db.getUserSession(userId, gymId)), never the active
// gym's; the background scan is NOT filtered by active gym; in-flight de-dupe
// keys include gymId.

const db = require('./db');
const { DateTime, IANAZone } = require('luxon');
// Additive coverage metadata for existing installations; no history is rewritten.
if (!db.db.prepare('PRAGMA table_info(class_history_sync)').all().some((c) => c.name === 'limited')) {
  db.db.exec('ALTER TABLE class_history_sync ADD COLUMN limited INTEGER NOT NULL DEFAULT 0');
}
const { getProvider } = require('./providers');
const { triggerAutoRelogin } = require('./auth');
const backoff = require('./rate-limit-backoff');
const gymOutbound = require('./gym-outbound');

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// A booking's outcome can settle after the class (MarianaTek no-show / check-in
// processing), so an incremental pull re-reads this much history before the last sync.
const OVERLAP_MS = 14 * 24 * 60 * 60 * 1000;
// Which statuses count as "took the class" for aggregates. `unconfirmed` is a past,
// uncancelled booking with no positive attendance signal (see providers/normalize.js);
// it is counted by default (user decision 2026-10-05): CodexFit's past list gives no
// attendance signal at all and some studios never check members in.
const COUNTED_STATUSES = ['attended', 'unconfirmed'];

const inflight = new Map(); // `${userId}:${gymId}` -> Promise (gym in the key: ids collide)

function key(userId, gymId) { return `${userId}:${gymId}`; }

function upsertEntries(userId, gymId, entries, fetchedAt = new Date().toISOString()) {
  if (!gymId) throw new Error('class-history: gymId is required');
  const stmt = db.db.prepare(`
    INSERT INTO class_history
      (user_id, gym_id, booking_id, event_id, status, start_at, start_ts, time_zone, duration_min,
       class_name, discipline, instructor_id, instructor_name, studio_id, studio_name,
       location_id, location_name, slot_label, spot_section, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, gym_id, booking_id) DO UPDATE SET
      event_id = excluded.event_id, status = excluded.status, start_at = excluded.start_at,
      start_ts = excluded.start_ts, time_zone = excluded.time_zone, duration_min = excluded.duration_min,
      class_name = excluded.class_name, discipline = excluded.discipline,
      instructor_id = excluded.instructor_id, instructor_name = excluded.instructor_name,
      studio_id = excluded.studio_id, studio_name = excluded.studio_name,
      location_id = excluded.location_id, location_name = excluded.location_name,
      slot_label = excluded.slot_label, spot_section = excluded.spot_section,
      fetched_at = excluded.fetched_at
  `);
  let n = 0;
  const tx = db.db.transaction(() => {
    for (const e of entries) {
      const ts = Date.parse(e.startAt);
      if (!e.bookingId || !e.startAt || !Number.isFinite(ts)) continue;
      stmt.run(userId, gymId, e.bookingId, e.eventId ?? null, e.status, e.startAt, ts, e.timeZone ?? null,
        e.durationMin ?? null, e.name ?? null, e.discipline ?? null, e.instructorId ?? null,
        e.instructorName ?? null, e.studioId ?? null, e.studioName ?? null, e.locationId ?? null,
        e.locationName ?? null, e.slotLabel ?? null, e.spotSection ?? null, fetchedAt);
      n++;
    }
  });
  tx();
  return n;
}

function rowToEntry(r) {
  const out = {
    bookingId: r.booking_id, eventId: r.event_id, status: r.status, startAt: r.start_at,
    timeZone: r.time_zone, durationMin: r.duration_min, name: r.class_name, discipline: r.discipline,
    instructorId: r.instructor_id, instructorName: r.instructor_name, studioId: r.studio_id,
    studioName: r.studio_name, locationId: r.location_id, locationName: r.location_name,
    slotLabel: r.slot_label, spotSection: r.spot_section,
    fetchedAt: r.fetched_at,
  };
  Object.keys(out).forEach((k) => (out[k] == null) && delete out[k]);
  return out;
}

function listHistory(userId, gymId, { sinceDate, limit = 500, statuses } = {}) {
  const sinceTs = sinceDate ? Date.parse(sinceDate) : 0;
  let sql = 'SELECT * FROM class_history WHERE user_id = ? AND gym_id = ? AND start_ts >= ?';
  const args = [userId, gymId, Number.isFinite(sinceTs) ? sinceTs : 0];
  if (Array.isArray(statuses) && statuses.length) {
    sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
    args.push(...statuses);
  }
  sql += ' ORDER BY start_ts DESC LIMIT ?';
  args.push(Math.max(1, Math.min(5000, Number(limit) || 500)));
  return db.db.prepare(sql).all(...args).map(rowToEntry);
}

/** Counts DISTINCT classes (a multi-slot/guest booking is still one class) per instructor over the last `days`, one gym. Ties go to the most recent class. */
function topInstructors(userId, gymId, { days = 30, statuses = COUNTED_STATUSES, limit = 5, now = Date.now() } = {}) {
  const sinceTs = now - days * 864e5;
  const rows = db.db.prepare(`
    SELECT instructor_id, MAX(instructor_name) AS instructor_name,
           COUNT(DISTINCT COALESCE(event_id, booking_id)) AS n, MAX(start_ts) AS last_ts
    FROM class_history
    WHERE user_id = ? AND gym_id = ? AND start_ts >= ? AND start_ts <= ?
      AND instructor_id IS NOT NULL AND status IN (${statuses.map(() => '?').join(',')})
    GROUP BY instructor_id
    ORDER BY n DESC, last_ts DESC
    LIMIT ?
  `).all(userId, gymId, sinceTs, now, ...statuses, Math.max(1, Number(limit) || 5));
  return rows.map((r) => ({
    instructorId: r.instructor_id, instructorName: r.instructor_name, count: r.n,
    lastAt: new Date(r.last_ts).toISOString(),
  }));
}

/**
 * Gym-scoped, history-derived activity summary. A provider booking can have
 * multiple spots, so every aggregate groups by the normalized event id first.
 * This is a booking summary: no universal per-row attendance signal exists.
 */
function summary(userId, gymId, { statuses = COUNTED_STATUSES } = {}) {
  const row = db.db.prepare(`
    SELECT COUNT(*) AS class_count,
           COALESCE(SUM(duration_min), 0) AS total_minutes,
           COUNT(DISTINCT instructor_id) AS instructor_count
    FROM (
      SELECT COALESCE(NULLIF(event_id, ''), booking_id) AS class_key,
             MAX(duration_min) AS duration_min,
             MAX(instructor_id) AS instructor_id
      FROM class_history
      WHERE user_id = ? AND gym_id = ? AND status IN (${statuses.map(() => '?').join(',')})
      GROUP BY COALESCE(NULLIF(event_id, ''), booking_id)
    )
  `).get(userId, gymId, ...statuses);
  return {
    classCount: Number(row?.class_count) || 0,
    totalMinutes: Number(row?.total_minutes) || 0,
    instructorCount: Number(row?.instructor_count) || 0,
  };
}

function getSyncState(userId, gymId) {
  const r = db.db.prepare('SELECT * FROM class_history_sync WHERE user_id = ? AND gym_id = ?').get(userId, gymId);
  if (!r) return null;
  return { lastSyncedAt: r.last_synced_at, lastAttemptAt: r.last_attempt_at, lastError: r.last_error, rowCount: r.row_count, limited: !!r.limited };
}

function countRows(userId, gymId) {
  return db.db.prepare('SELECT COUNT(*) AS n FROM class_history WHERE user_id = ? AND gym_id = ?').get(userId, gymId).n;
}

function recordSync(userId, gymId, { ok, error, limited = false, full = false }) {
  const now = new Date().toISOString();
  db.db.prepare(`
    INSERT INTO class_history_sync (user_id, gym_id, last_synced_at, last_attempt_at, last_error, row_count, limited)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, gym_id) DO UPDATE SET
      last_synced_at = CASE WHEN ? THEN excluded.last_synced_at ELSE class_history_sync.last_synced_at END,
      last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error, row_count = excluded.row_count,
      limited = CASE WHEN ? THEN excluded.limited ELSE MAX(class_history_sync.limited, excluded.limited) END
  `).run(userId, gymId, ok ? now : null, now, ok ? null : String(error || 'failed').slice(0, 300),
    countRows(userId, gymId), limited ? 1 : 0, ok ? 1 : 0, ok && full ? 1 : 0);
}

async function pull(userId, gymId, sinceDate, onCoverage) {
  const provider = getProvider(gymId);
  const session = db.getUserSession(userId, gymId);
  if (!session || !session.accessToken) {
    const e = new Error(`no session for ${gymId}`);
    e.status = 401;
    throw e;
  }
  const opts = { ...(sinceDate ? { sinceDate } : {}), onCoverage };
  try {
    return await provider.listBookingHistory(session, opts);
  } catch (err) {
    if (!err || err.status !== 401) throw err;
    const newJwt = await triggerAutoRelogin(userId, gymId);
    return provider.listBookingHistory({ ...session, accessToken: newJwt }, opts);
  }
}

/**
 * Pull one gym's history for one user and upsert it (idempotent). The first pull
 * (no sync state) or `full: true` reads everything the API returns; later pulls
 * re-read from the last sync minus OVERLAP_MS. Never throws: failure is recorded
 * on the sync row and returned, so one dead gym cannot break a caller's loop.
 * @returns {Promise<{ok: boolean, upserted?: number, error?: string}>}
 */
function syncUserGym(userId, gymId, { full = false } = {}) {
  const k = key(userId, gymId);
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      if (!db.isGymLinked(userId, gymId)) return { ok: false, error: 'gym not linked' };
      if (!db.isUserGymEnabled(userId, gymId)) return { ok: false, error: 'gym turned off' };
      // Disabled gym/link: never pulled. Not recorded as a sync failure either —
      // the stored rows are the answer for as long as it stays disabled.
      if (gymOutbound.isOutboundBlocked(gymId, userId)) return { ok: false, error: 'gym disabled', disabled: true };
      const state = getSyncState(userId, gymId);
      const since = (!full && state && state.lastSyncedAt)
        ? new Date(Date.parse(state.lastSyncedAt) - OVERLAP_MS).toISOString()
        : undefined;
      let limited = false;
      const entries = await pull(userId, gymId, since, (coverage) => { limited = !!coverage.limited; });
      // A member may unlink while a provider pull is in flight: never resurrect their history.
      if (!db.isGymLinked(userId, gymId)) return { ok: false, error: 'gym not linked' };
      const upserted = upsertEntries(userId, gymId, entries);
      recordSync(userId, gymId, { ok: true, limited, full: !since });
      return { ok: true, upserted };
    } catch (err) {
      try { backoff.noteThrottleError(gymId, err); } catch (_) {}
      try { if (db.isGymLinked(userId, gymId)) recordSync(userId, gymId, { ok: false, error: err.message }); } catch (_) {}
      return { ok: false, error: err.message };
    } finally {
      inflight.delete(k);
    }
  })();
  inflight.set(k, p);
  return p;
}

/**
 * Lazy backfill: if this (user, gym) has never synced, await the first full pull;
 * if the data is older than maxAgeMs, refresh in the background and return now.
 */
async function ensureHistory(userId, gymId, { maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (gymOutbound.isOutboundBlocked(gymId, userId)) return { ok: true, cached: true, disabled: true };
  const state = getSyncState(userId, gymId);
  if (!state || !state.lastSyncedAt) return syncUserGym(userId, gymId, { full: true });
  if (Date.now() - Date.parse(state.lastSyncedAt) > maxAgeMs) syncUserGym(userId, gymId).catch(() => {});
  return { ok: true, cached: true };
}

/**
 * Background scan: every user x every linked gym whose history is missing or stale.
 * Deliberately NOT filtered by active gym. Skips suspended links and gyms in
 * provider rate-limit backoff, and disabled gyms/links. Sequential, so it never bursts a provider.
 */
async function syncStale({ maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const links = db.db.prepare(`
    SELECT ug.user_id, ug.gym_id FROM user_gyms ug
    LEFT JOIN class_history_sync s ON s.user_id = ug.user_id AND s.gym_id = ug.gym_id
    WHERE ug.relogin_suspended = 0 AND ug.status != 'disabled' AND ug.account_enabled = 1
      AND (s.last_synced_at IS NULL OR s.last_synced_at < ?)
  `).all(new Date(Date.now() - maxAgeMs).toISOString());
  let done = 0;
  for (const l of links) {
    if (backoff.isGymRateLimited(l.gym_id)) continue;
    if (gymOutbound.isOutboundBlocked(l.gym_id, l.user_id)) continue;
    const r = await syncUserGym(l.user_id, l.gym_id);
    if (r.ok) done++;
  }
  return { scanned: links.length, synced: done };
}

/** Invalid or missing viewer zones use UTC, never an invented gym/account zone. */
function analysisZoneOf(zone) { return typeof zone === 'string' && IANAZone.isValidZone(zone) ? zone : 'UTC'; }

/** Pure private-history projection. No raw/provider fields escape this function. */
function aggregatePersonalHistory(entries, { zone = 'UTC', now = Date.now(), coverage = [] } = {}) {
  const analysisZone = analysisZoneOf(zone);
  const today = DateTime.fromMillis(now, { zone: analysisZone }).startOf('day');
  const volume = Array.from({ length: 30 }, (_, i) => ({ date: today.minus({ days: 29 - i }).toISODate(), count: 0 }));
  const daily = new Map(volume.map((p) => [p.date, p]));
  const weekdays = Array(7).fill(0), timeBins = Array(6).fill(0), hours = Array(24).fill(0), mix = new Map(), weeks = new Set(), seen = new Set();
  const patternStart = today.minus({ days: 89 });
  let total = 0;
  for (const e of entries) {
    if (!COUNTED_STATUSES.includes(e.status)) continue;
    const ts = Date.parse(e.startAt);
    const duration = Number(e.durationMin);
    if (!Number.isFinite(ts) || ts >= now || (duration > 0 && ts + duration * 60000 > now)) continue;
    const identity = e.eventId != null && String(e.eventId).trim() !== '' ? ['event', String(e.eventId)] : ['booking', String(e.bookingId)];
    if (!e.gymId || (identity[0] === 'booking' && !e.bookingId)) continue;
    const k = JSON.stringify([e.gymId, ...identity]);
    if (seen.has(k)) continue;
    seen.add(k); total++;
    const viewerDay = DateTime.fromMillis(ts, { zone: analysisZone });
    weeks.add(viewerDay.startOf('week').toISODate());
    const point = daily.get(viewerDay.toISODate());
    if (point) point.count++;
    if (viewerDay < patternStart) continue;
    // Habits are experienced in the class's own zone; invalid historical zones use viewer zone.
    const local = DateTime.fromMillis(ts, { zone: IANAZone.isValidZone(e.timeZone) ? e.timeZone : analysisZone });
    weekdays[local.weekday - 1]++;
    timeBins[Math.floor(local.hour / 4)]++;
    hours[local.hour]++;
    mix.set(e.gymId, (mix.get(e.gymId) || 0) + 1);
  }
  let cursor = today.startOf('week');
  if (!weeks.has(cursor.toISODate())) cursor = cursor.minus({ weeks: 1 });
  let streak = 0;
  while (weeks.has(cursor.toISODate())) { streak++; cursor = cursor.minus({ weeks: 1 }); }
  const pending = coverage.some((c) => c.state === 'pending');
  const partial = coverage.some((c) => ['failed', 'stale', 'disabled'].includes(c.state) || c.limited);
  const patternTotal = [...mix.values()].reduce((a, b) => a + b, 0);
  return {
    analysisZone, generatedAt: new Date(now).toISOString(), basis: 'past-bookings', pending, partial,
    totalPastClasses: total, streak: { weeks: streak, atLeast: partial || pending },
    volume: { days: 30, points: volume },
    patterns: { days: 90, weekdays, timeBins, hours, gymMix: [...mix].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([gymId, count]) => ({ gymId, count, percent: patternTotal ? Math.round(count * 100 / patternTotal) : 0 })) },
    coverage,
  };
}

// One paced import loop per account, reusing the existing gym-keyed in-flight pipeline.
const personalRefreshes = new Map();
function refreshPersonalHistory(userId, links) {
  if (personalRefreshes.has(userId)) return;
  const needs = links.filter((link) => {
    if (gymOutbound.isOutboundBlocked(link.gym_id, userId) || backoff.isGymRateLimited(link.gym_id) || link.relogin_suspended) return false;
    const state = getSyncState(userId, link.gym_id);
    return (!state?.lastSyncedAt || Date.now() - Date.parse(state.lastSyncedAt) > DEFAULT_MAX_AGE_MS)
      && (!state?.lastAttemptAt || Date.now() - Date.parse(state.lastAttemptAt) > 60000);
  });
  if (!needs.length) return;
  const task = (async () => {
    for (const link of needs) await ensureHistory(userId, link.gym_id);
  })().finally(() => personalRefreshes.delete(userId));
  personalRefreshes.set(userId, task);
}

/** Account-level aggregate over ALL stored linked history, without list/date caps. */
function personalStats(userId, { zone, now = Date.now(), refresh = true } = {}) {
  const links = db.getUserGymsPublic(userId);
  if (refresh) refreshPersonalHistory(userId, links);
  const rows = db.db.prepare(`
    SELECT h.gym_id, h.booking_id, h.event_id, h.status, h.start_at, h.time_zone, h.duration_min
    FROM class_history h JOIN user_gyms ug ON ug.user_id = h.user_id AND ug.gym_id = h.gym_id
    WHERE h.user_id = ? AND h.status IN ('attended', 'unconfirmed') AND h.start_ts < ?
    ORDER BY h.start_ts, h.booking_id
  `).iterate(userId, now);
  const entries = (function* () { for (const r of rows) yield { gymId: r.gym_id, ...rowToEntry(r) }; })();
  const coverage = links.map((link) => {
    const gymId = link.gym_id, sync = getSyncState(userId, gymId);
    const disabled = gymOutbound.isOutboundBlocked(gymId, userId);
    const state = disabled ? 'disabled' : sync?.lastError ? 'failed' : !sync?.lastSyncedAt ? 'pending'
      : now - Date.parse(sync.lastSyncedAt) > DEFAULT_MAX_AGE_MS ? 'stale' : 'ready';
    const first = db.db.prepare('SELECT MIN(start_ts) AS ts FROM class_history WHERE user_id = ? AND gym_id = ?').get(userId, gymId).ts;
    return { gymId, state, lastSyncedAt: sync?.lastSyncedAt || null, earliestStoredAt: first == null ? null : new Date(first).toISOString(), limited: !!sync?.limited };
  });
  return aggregatePersonalHistory(entries, { zone, now, coverage });
}

module.exports = {
  analysisZoneOf, aggregatePersonalHistory, personalStats, COUNTED_STATUSES, upsertEntries, listHistory, topInstructors, summary, getSyncState,
  syncUserGym, ensureHistory, syncStale,
};
