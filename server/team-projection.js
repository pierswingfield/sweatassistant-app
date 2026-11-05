// T-2 Team projection (PLAN-teams.md §2 principle 1, §3, §4, §7.3). PURE: rows in,
// payload out. No db, no network; the clock and zones are inputs. server/team-data.js
// reads the rows and server/teams.js decides membership; this module decides what one
// viewer may see of everyone else, and it is the only place that decision is made.
//
// §7.3, for viewer V, Team T and member M (V included, under the same rules, so V sees
// exactly what the Team sees of them):
//   an item of M is included only if
//     M is a current member (the caller passes only team_members rows)
//     ∧ M is not paused
//     ∧ the item's category is shared in M.share
//     ∧ the item's gym is in M.share.gyms
//     ∧ M's link to that gym exists and is enabled (user_gyms.account_enabled)
//     ∧ the item is not cancelled, late-cancelled, no-show or class-cancelled
//     ∧ (booking rows) it came from the SERVER's sync, never only from a client push
//     ∧ (booking rows the latest sync no longer lists, `missing_since`) class_history
//       confirms it: attended/unconfirmed for the same gym-qualified booking id.
//   Details (gym, time, class, place, spot) are shown only if V has that gym linked
//   (enabled, or paused-but-linked, §4); otherwise it only adds to "+N at other gyms".
//
// Categories (team-sharing.js): upcoming (booking_cache), waitlists (waitlist_cache),
// autoBookQueue (pending auto_bookings), spots (slot labels on bookings), activity
// (week/month counts and the mascot's day), recent (class_history, last 30 days).
//
// Payload rules: no user ids, emails or gym logins; members by memberRef. Class keys are
// gym-qualified (`gymId:eventId`, WP-G). Times are ISO in the CLASS's own zone, with
// `timeZone` alongside.

const { DateTime } = require('luxon');
const sharing = require('./team-sharing');
const mascot = require('./team-mascot');

const COUNTED = new Set(['attended', 'unconfirmed']);
const HOUR = 3600 * 1000;

const str = (v) => (v == null ? '' : String(v));
const classKey = (gymId, eventId) => `${gymId}:${eventId}`;

function isPausedAt(pausedUntil, now) {
  if (!pausedUntil) return false;
  const t = Date.parse(pausedUntil);
  return Number.isFinite(t) ? t > now : true; // unparseable pause = paused (fail safe)
}

function sharesGym(share, gymId) {
  return share.gyms === 'all' || (Array.isArray(share.gyms) && share.gyms.includes(gymId));
}

function toInstant(iso, zone) {
  if (!iso) return null;
  const dt = DateTime.fromISO(String(iso), { zone: zone || 'UTC' });
  return dt.isValid ? dt : null;
}

/**
 * @param {object} input
 * @param {{userId: number, linkedGymIds: string[]}} input.viewer  linked = any user_gyms row
 * @param {{id: string}} input.team
 * @param {object[]} input.members  one per team_members row: { userId, memberRef, name,
 *   colourIndex, isCaptain, share (stored JSON or object), pausedUntil, links: user_gyms rows,
 *   bookings: booking_cache rows, waitlists: waitlist_cache rows, queue: auto_bookings rows,
 *   history: class_history rows, syncState: booking_sync_state rows }
 * @param {number} input.now   epoch ms
 * @param {string} input.zone  the viewer's IANA zone ("today", week and month boundaries)
 * @param {(gymId: string) => string} input.zoneOf  a gym's zone (providers/timezone.zoneOfGym)
 * @param {number} [input.staleAfterMs]  freshness cadence for "Updated 3 h ago"
 * @param {boolean} [input.includeDetail]  false = list summary only (no classes/recent arrays)
 */
function projectTeam(input) {
  const {
    viewer, team, members = [], now, zone = 'UTC', zoneOf,
    staleAfterMs = 2 * HOUR, includeDetail = true,
  } = input;
  if (!viewer || !members.some((m) => m.userId === viewer.userId)) {
    throw new Error('projectTeam: the viewer is not a member of this Team');
  }
  const viewerGyms = new Set(viewer.linkedGymIds || []);
  const local = DateTime.fromMillis(now, { zone });
  const weekStart = local.startOf('week').toMillis();
  const monthStart = local.startOf('month').toMillis();
  const recentStart = now - sharing.RECENT_DAYS * 24 * HOUR;
  const zoneFor = (gymId) => (zoneOf ? zoneOf(gymId) : 'UTC') || 'UTC';
  const isTodayIn = (dt) => dt.hasSame(DateTime.fromMillis(now, { zone: dt.zoneName }), 'day');

  const classes = new Map();   // key -> visible class (details)
  const recent = new Map();    // key -> visible past class (details)
  const todayAll = new Map();  // key -> { startMs, endMs, discipline, className } (activity, all gyms)
  const other = { upcoming: new Set(), today: new Set(), recent: new Set() };
  const outMembers = [];
  const nameOf = new Map();

  const describe = (gymId, eventId, row, dt, durationMin) => {
    const startMs = dt.toMillis();
    const endMs = mascot.endMsOf(startMs, durationMin);
    return {
      key: classKey(gymId, eventId),
      gymId,
      eventId: str(eventId),
      startAt: dt.setZone(zoneFor(gymId)).toISO(),
      timeZone: zoneFor(gymId),
      durationMin: Number(durationMin) > 0 ? Number(durationMin) : null,
      className: str(row.class_name) || 'Class',
      discipline: str(row.group_name ?? row.discipline),
      instructorName: str(row.instructor_name),
      studioName: str(row.studio_name),
      locationName: str(row.location_name),
      status: endMs <= now ? 'done' : (startMs <= now ? 'inProgress' : 'upcoming'),
      _startMs: startMs,
      _endMs: endMs,
      attendees: [],
    };
  };

  const addAttendee = (map, cls, memberRef, kind, spot) => {
    if (!map.has(cls.key)) map.set(cls.key, cls);
    const target = map.get(cls.key);
    const rank = { booked: 3, waitlist: 2, queued: 1 };
    const prev = target.attendees.find((a) => a.memberRef === memberRef);
    if (prev) {
      if (rank[kind] > rank[prev.kind]) { prev.kind = kind; delete prev.spot; }
      if (spot && prev.kind === 'booked') prev.spot = prev.spot ? `${prev.spot}, ${spot}` : spot;
      return;
    }
    const a = { memberRef, kind };
    if (spot) a.spot = spot;
    target.attendees.push(a);
  };

  const noteToday = (cls) => {
    if (!todayAll.has(cls.key)) {
      todayAll.set(cls.key, { startMs: cls._startMs, endMs: cls._endMs, discipline: cls.discipline, className: cls.className });
    }
  };

  for (const m of members) {
    const isMe = m.userId === viewer.userId;
    const share = sharing.resolveShare(m.share);
    const paused = isPausedAt(m.pausedUntil, now);
    nameOf.set(m.memberRef, m.name);
    const enabledGyms = new Set((m.links || []).filter((l) => l && (l.account_enabled === 1 || l.account_enabled === true)).map((l) => l.gym_id));
    const gymOk = (gymId) => !paused && !!gymId && sharesGym(share, gymId) && enabledGyms.has(gymId);
    const visible = (gymId) => viewerGyms.has(gymId);

    // Penalised or cancelled outcomes, by gym-qualified booking id: such a booking is
    // never shown, even while its booking_cache row lingers.
    const excludedBookings = new Set();
    const countedHistory = [];
    for (const h of m.history || []) {
      if (!h || !h.gym_id) continue;
      if (!COUNTED.has(h.status)) { excludedBookings.add(classKey(h.gym_id, h.booking_id)); continue; }
      countedHistory.push(h);
    }

    // §7.2: history rows that confirm a booking happened (present in the gym's past list,
    // not penalised). A booking_cache row the latest sync no longer lists (missing_since)
    // may have been late-cancelled, so it is shown or counted only once confirmed here.
    const confirmedBookings = new Set(countedHistory.map((h) => classKey(h.gym_id, h.booking_id)));

    // Activity counts dedupe by gym-qualified booking id across history and today's
    // already-finished bookings (the history sync can lag the class by hours).
    const counted = new Map(); // gym:bookingId -> startMs
    const countIfActivity = (gymId, bookingId, startMs) => {
      if (!share.activity || !gymOk(gymId)) return;
      counted.set(classKey(gymId, bookingId), startMs);
    };

    // Upcoming (and today's started/finished) bookings: server-synced rows only.
    for (const b of m.bookings || []) {
      if (!b || b.origin !== 'server' || !b.gym_id || b.event_id == null) continue;
      if (excludedBookings.has(classKey(b.gym_id, b.booking_id))) continue;
      if (b.missing_since && !confirmedBookings.has(classKey(b.gym_id, b.booking_id))) continue;
      if (!gymOk(b.gym_id)) continue;
      const dt = toInstant(b.start_at, zoneFor(b.gym_id));
      if (!dt) continue;
      const cls = describe(b.gym_id, b.event_id, b, dt, b.duration_min);
      const today = isTodayIn(dt.setZone(zoneFor(b.gym_id)));
      if (cls._endMs <= now && !today) continue; // a lingering past row
      if (share.activity && today) {
        noteToday(cls);
        if (!visible(b.gym_id)) other.today.add(cls.key);
      }
      if (cls._endMs <= now) countIfActivity(b.gym_id, b.booking_id, cls._startMs);
      if (!share.upcoming) continue;
      if (!visible(b.gym_id)) { if (cls._endMs > now) other.upcoming.add(cls.key); continue; }
      const spot = share.spots ? str(b.slot_label).trim() : '';
      addAttendee(classes, cls, m.memberRef, 'booked', spot || null);
    }

    // Past classes from the history store.
    for (const h of countedHistory) {
      if (!gymOk(h.gym_id)) continue;
      const z = zoneFor(h.gym_id);
      const dt = h.start_ts != null ? DateTime.fromMillis(Number(h.start_ts), { zone: z }) : toInstant(h.start_at, h.time_zone || z);
      if (!dt || !dt.isValid) continue;
      const startMs = dt.toMillis();
      if (startMs > now) continue;
      countIfActivity(h.gym_id, h.booking_id, startMs);
      const eventId = h.event_id != null ? h.event_id : `b${h.booking_id}`;
      const cls = describe(h.gym_id, eventId, h, dt, h.duration_min);
      const today = isTodayIn(dt.setZone(z));
      if (today && share.activity) {
        noteToday(cls);
        if (!visible(h.gym_id)) other.today.add(cls.key);
      }
      if (today && share.upcoming && visible(h.gym_id)) addAttendee(classes, { ...cls, attendees: [] }, m.memberRef, 'booked', null);
      if (!share.recent || startMs < recentStart) continue;
      if (!visible(h.gym_id)) { other.recent.add(`${m.memberRef}|${cls.key}`); continue; }
      addAttendee(recent, { ...cls, attendees: [] }, m.memberRef, 'booked', null);
    }

    if (share.waitlists) {
      for (const w of m.waitlists || []) {
        if (!w || !gymOk(w.gym_id) || w.event_id == null) continue;
        const dt = toInstant(w.start_at, zoneFor(w.gym_id));
        if (!dt || dt.toMillis() <= now) continue;
        if (!visible(w.gym_id)) continue; // waitlists are not part of "+N" (classes only)
        addAttendee(classes, describe(w.gym_id, w.event_id, w, dt, null), m.memberRef, 'waitlist', null);
      }
    }

    if (share.autoBookQueue) {
      for (const q of m.queue || []) {
        if (!q || q.status !== 'pending' || q.executed_at || !gymOk(q.gym_id) || q.event_id == null) continue;
        const dt = toInstant(q.start_at, zoneFor(q.gym_id));
        if (!dt || dt.toMillis() <= now) continue;
        if (!visible(q.gym_id)) continue;
        addAttendee(classes, describe(q.gym_id, q.event_id, q, dt, q.duration_min), m.memberRef, 'queued', null);
      }
    }

    let counts = null;
    if (share.activity && !paused) {
      const starts = [...counted.values()];
      counts = { week: starts.filter((s) => s >= weekStart).length, month: starts.filter((s) => s >= monthStart).length };
    }

    // Freshness: the oldest server sync among the gyms this member shares with the Team.
    let updatedAt = null;
    let stale = false;
    if (!paused && (share.upcoming || share.waitlists)) {
      const gyms = [...enabledGyms].filter((g) => sharesGym(share, g));
      const times = gyms.map((g) => {
        const st = (m.syncState || []).find((s) => s && s.gym_id === g);
        const t = st && st.last_synced_at ? Date.parse(st.last_synced_at) : NaN;
        return Number.isFinite(t) ? t : null;
      });
      if (gyms.length) {
        if (times.some((t) => t === null)) stale = true;
        const known = times.filter((t) => t !== null);
        if (known.length) {
          const oldest = Math.min(...known);
          updatedAt = new Date(oldest).toISOString();
          if (now - oldest > staleAfterMs) stale = true;
        }
      }
    }

    outMembers.push({
      memberRef: m.memberRef,
      name: m.name,
      colourIndex: m.colourIndex,
      isCaptain: !!m.isCaptain,
      isMe,
      counts,
      updatedAt,
      stale,
    });
  }

  // ---- shape the visible classes ------------------------------------------------------
  const ordered = [...classes.values()].sort((a, b) => a._startMs - b._startMs || a.key.localeCompare(b.key));
  const booked = (c) => c.attendees.filter((a) => a.kind === 'booked');
  const notEnded = ordered.filter((c) => c._endMs > now);
  const zoneToday = (c) => isTodayIn(DateTime.fromMillis(c._startMs, { zone: c.timeZone }));
  const todayVisible = ordered.filter((c) => zoneToday(c) && booked(c).length);

  const todayList = [...todayAll.values()];
  const total = todayList.length;
  const done = todayList.filter((c) => c.endMs <= now).length;
  const inProgress = todayList.filter((c) => c.startMs <= now && now < c.endMs).length;
  const remaining = total - done - inProgress;

  const brief = (c) => ({
    key: c.key, gymId: c.gymId, startAt: c.startAt, timeZone: c.timeZone,
    className: c.className, locationName: c.locationName,
  });

  let hottest = null;
  for (const c of notEnded) {
    const n = booked(c).length;
    if (n >= 2 && (!hottest || n > hottest.count)) hottest = { ...brief(c), count: n, attendees: booked(c).map((a) => a.memberRef) };
  }
  const nextToday = todayVisible.find((c) => c._startMs > now);
  let solo = null;
  if (!hottest && nextToday && booked(nextToday).length === 1) {
    const ref = booked(nextToday)[0].memberRef;
    solo = { ...brief(nextToday), memberRef: ref, name: nameOf.get(ref) };
  }
  let next = null;
  if (remaining === 0 && inProgress === 0) {
    const after = notEnded.find((c) => !zoneToday(c) && booked(c).length);
    if (after) {
      const n = booked(after).length;
      const afterDay = DateTime.fromMillis(after._startMs, { zone: after.timeZone });
      const tomorrow = afterDay.hasSame(DateTime.fromMillis(now, { zone: after.timeZone }).plus({ days: 1 }), 'day');
      next = { ...brief(after), when: tomorrow ? 'tomorrow' : 'later', count: n };
      if (n === 1) { next.memberRef = booked(after)[0].memberRef; next.name = nameOf.get(next.memberRef); }
    }
  }
  const firstUpcoming = todayVisible.find((c) => c._startMs > now);
  const activeRefs = new Set();
  for (const c of todayVisible) for (const a of booked(c)) activeRefs.add(a.memberRef);

  const today = {
    total, done, inProgress, remaining,
    otherGyms: other.today.size,
    firstAt: firstUpcoming ? { startAt: firstUpcoming.startAt, timeZone: firstUpcoming.timeZone } : null,
    hottest, solo, next,
    activeToday: outMembers.filter((m) => activeRefs.has(m.memberRef)).map((m) => m.memberRef),
  };

  const strip = ({ _startMs, _endMs, ...rest }) => rest;
  const out = {
    teamId: team.id,
    members: outMembers,
    today,
    mascot: mascot.mascotFor({ teamId: team.id, classes: todayList, now, zone }),
    otherGyms: { upcoming: other.upcoming.size, today: other.today.size, recent: other.recent.size },
    soonestAt: notEnded.find((c) => booked(c).length) ? notEnded.find((c) => booked(c).length).startAt : null,
  };
  if (includeDetail) {
    out.classes = ordered.filter((c) => c._endMs > now || zoneToday(c)).map(strip);
    out.recent = [...recent.values()].sort((a, b) => b._startMs - a._startMs).map(strip);
  }
  return out;
}

module.exports = { projectTeam, classKey, COUNTED_STATUSES: [...COUNTED] };
