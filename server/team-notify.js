// T-5 Teams pushes (PLAN-teams.md §5.3 "Pushes"). Exactly the three the plan defines:
//
//   teamRequest   a join request, to the Team's Captains (not paused in that Team)
//   teamApproved  "You're in", to the requester once a Captain approves
//   teamBooked    "Ana booked 08:30 Train, a class you're in", to teammates booked into
//                 the same class who may see the booker there
//
// Preferences (T-5b, §5.3 "Pushes, opt-in per Team and conservative by default"):
//   - teamRequest and teamBooked follow the recipient's per-Team switch
//     (`team_members.alerts_enabled`, set on that Team's Manage page, default OFF). The
//     switch of the Team the event belongs to decides; for teamBooked only Teams where the
//     recipient opted in may carry the alert (teams.teammateBookingAlerts), and the chosen
//     Team's switch is re-checked here.
//   - teamApproved goes to someone who is not yet a member, so it has no Team page to set
//     it on: it stays the account-level switch in Customise Notifications (default ON,
//     §5.6 "approved means a push").
//
// Never "Ana booked a class" in general (§5.3: spam in a ten-person Team).
//
// Who may learn what is decided by teams.js through the projection (teammateBookingAlerts
// asks the recipient's own projection whether the booker is a visible booked attendee of
// that class). This module adds the preference checks above, the dedupe ledger
// (sent_notifications) and the rate limits:
//
//   - teamBooked: once per (recipient, booker, class), ever; at most one per (recipient,
//     class) per BOOKED_CLASS_COOLDOWN_MS, so 15 teammates piling into one class make one
//     push whose body counts them ("4 teammates are going"), not fifteen;
//   - teamRequest: at most one per (Captain, Team) per REQUEST_COOLDOWN_MS; the body says
//     how many are waiting, so a burst of requests is one push;
//   - teamRequest + teamBooked together: at most TEAM_DAILY_CAP per recipient in 24 h;
//   - teamApproved: once per request (a decision the recipient is waiting for; uncapped).
//
// Payloads carry no user ids, emails or memberRefs: { type, url: '/teams/<teamId>' }, a
// route the recipient (a member) can open.

const db = require('./db');
const teams = require('./teams');
const notifications = require('./notifications');

const HOUR = 3600 * 1000;
const BOOKED_CLASS_COOLDOWN_MS = 6 * HOUR;
const REQUEST_COOLDOWN_MS = 1 * HOUR;
const DAILY_WINDOW_MS = 24 * HOUR;
const TEAM_DAILY_CAP = 6;

const SENT = 'team:push:'; // every Team push actually dispatched leaves one row under this prefix

const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const now = () => teams.__now();
const prefsOn = (userId, type) => {
  try { return !!notifications.getPrefs(userId)[type].enabled; } catch (_) { return false; }
};
const teamAlertsOn = (userId, teamId) => {
  try { return teams.alertsEnabledFor(userId, teamId); } catch (_) { return false; }
};
const sentSince = (userId, prefix, windowMs) => db.countNotificationsSince(userId, prefix, sqlTime(now() - windowMs));
const overDailyCap = (userId) => sentSince(userId, `${SENT}teamRequest:`, DAILY_WINDOW_MS)
  + sentSince(userId, `${SENT}teamBooked:`, DAILY_WINDOW_MS) >= TEAM_DAILY_CAP;

let seq = 0;
function recordSend(userId, type, scope) {
  seq = (seq + 1) % 1e6;
  db.markNotificationSent(userId, `${SENT}${type}:${scope}:${now()}-${seq}`, sqlTime(now()));
}

/** @returns {Promise<string>} 'sent' | 'off' | 'duplicate' | 'cooldown' | 'capped' | 'gone' */
async function joinRequested(teamId) {
  const target = teams.joinRequestTargets(teamId);
  if (!target) return [];
  const results = [];
  for (const { userId, alertsEnabled } of target.captains) {
    if (!alertsEnabled) { results.push('off'); continue; }
    if (sentSince(userId, `${SENT}teamRequest:${target.teamId}:`, REQUEST_COOLDOWN_MS) > 0) { results.push('cooldown'); continue; }
    if (overDailyCap(userId)) { results.push('capped'); continue; }
    recordSend(userId, 'teamRequest', target.teamId);
    await notifications.notify(userId, 'teamRequest', { teamName: target.teamName, pending: target.pending, url: `/teams/${target.teamId}` });
    results.push('sent');
  }
  return results;
}

async function requestApproved(teamId, userId, requestId) {
  const target = teams.approvalTarget(teamId, userId);
  if (!target) return 'gone';
  if (!prefsOn(userId, 'teamApproved')) return 'off';
  const key = `team:approved:${requestId}`;
  if (db.wasNotificationSent(userId, key)) return 'duplicate';
  db.markNotificationSent(userId, key, sqlTime(now()));
  recordSend(userId, 'teamApproved', target.teamId);
  await notifications.notify(userId, 'teamApproved', { teamName: target.teamName, url: `/teams/${target.teamId}` });
  return 'sent';
}

/**
 * booking-sync.js calls this with the booker's NEW server-synced rows for one gym (rows
 * the previous sync did not hold as server rows). Classes already started are ignored.
 */
async function newServerBookings(bookerId, gymId, rows) {
  const t = now();
  const eventIds = (rows || [])
    .filter((r) => r && r.eventId != null && Date.parse(r.startAt) > t)
    .map((r) => r.eventId);
  if (!eventIds.length) return [];
  const results = [];
  for (const a of teams.teammateBookingAlerts(bookerId, gymId, eventIds)) {
    results.push({ recipientId: a.recipientId, key: a.cls.key, outcome: await teammateBooked(bookerId, a) });
  }
  return results;
}

async function teammateBooked(bookerId, alert) {
  const userId = alert.recipientId;
  if (!teamAlertsOn(userId, alert.teamId)) return 'off';
  const key = `team:booked:${alert.cls.key}:u${bookerId}`;
  if (db.wasNotificationSent(userId, key)) return 'duplicate';
  // Marked even when the push is then held back: a later sync must not replay it.
  db.markNotificationSent(userId, key, sqlTime(now()));
  if (sentSince(userId, `${SENT}teamBooked:${alert.cls.key}:`, BOOKED_CLASS_COOLDOWN_MS) > 0) return 'cooldown';
  if (overDailyCap(userId)) return 'capped';
  recordSend(userId, 'teamBooked', alert.cls.key);
  await notifications.notify(userId, 'teamBooked', {
    teamName: alert.teamName,
    bookerName: alert.bookerName,
    others: alert.others,
    gymId: alert.cls.gymId,
    startAt: alert.cls.startAt,
    timeZone: alert.cls.timeZone,
    className: alert.cls.className,
    discipline: alert.cls.discipline,
    url: `/teams/${alert.teamId}`,
  });
  return 'sent';
}

/** teams.js event listener (installed in server.js). */
function onTeamEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  if (evt.type === 'joinRequested') return joinRequested(evt.teamId);
  if (evt.type === 'requestApproved') return requestApproved(evt.teamId, evt.userId, evt.requestId);
  return null;
}

module.exports = {
  onTeamEvent,
  joinRequested,
  requestApproved,
  newServerBookings,
  BOOKED_CLASS_COOLDOWN_MS,
  REQUEST_COOLDOWN_MS,
  TEAM_DAILY_CAP,
};
