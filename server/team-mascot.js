// T-2 Team mascot (PLAN-teams.md §5.4). PURE: no db, no network, no clock of its own.
//
// The ONE source of truth for the mascot: its state machine, the daily exercising-pose
// rotation, pose eligibility and the day-progress ring. It lives on the server because
// the state counts classes the viewer may not see in detail ("+N at other gyms", §4):
// only the server holds their times, so only the server can say "someone is in class
// now". The client receives { state, pose, asset, ring, fit } and names no pose itself.
//
// A new pose is one REGISTRY entry plus an asset under client/public/characters/; no
// caller changes. Eligibility rules see the day's classes as { discipline, className }.

const crypto = require('crypto');
const { DateTime } = require('luxon');

const asset = (name) => `/characters/team-${name}.webp`;
const isCycle = (c) => /\b(ride|cycl\w*|spin\w*|bike)\b/i.test(`${c.discipline || ''} ${c.className || ''}`);
const isBoxing = (c) => /box/i.test(`${c.discipline || ''} ${c.className || ''}`);

// Exercising poses, in a fixed order (the order is part of the rotation: append, never
// reorder, or every Team's pose for today changes on deploy).
const REGISTRY = Object.freeze([
  { id: 'dumbbell', asset: asset('dumbbell'), eligible: () => true },
  { id: 'running', asset: asset('running'), eligible: () => true },
  { id: 'handstand', asset: asset('handstand'), eligible: () => true },
  { id: 'skip', asset: asset('skip'), eligible: () => true },
  { id: 'boxing', asset: asset('boxing'), eligible: (classes) => classes.some(isBoxing) },
  { id: 'bike', asset: asset('bike'), eligible: (classes) => classes.some(isCycle) },
]);
const FALLBACK_POSE = 'dumbbell';

// Fixed art for the other states. `fit` renders the image smaller so the whole
// cooling-down picture (mat and bottle) sits inside the ring (§5.4).
const STATE_ART = Object.freeze({
  sleeping: { pose: 'bed', asset: asset('bed') },
  resting: { pose: 'stretch', asset: asset('stretch') },
  warming: { pose: 'running', asset: asset('running') },
  cooling: { pose: 'stretch', asset: asset('stretch'), fit: true },
  champion: { pose: 'champion', asset: asset('champion') },
});
const STATES = ['sleeping', 'resting', 'warming', 'exercising', 'cooling', 'champion'];

const NIGHT_START_HOUR = 22;
const MORNING_HOUR = 5;
const DEFAULT_DURATION_MIN = 45;

/**
 * The exercising pose for a Team on a date: deterministic per (teamId, dateKey), drawn
 * from the poses eligible for that day's classes. Falls back to dumbbell.
 * @param {string} teamId
 * @param {string} dateKey  yyyy-MM-dd (the viewer's local date)
 * @param {{discipline?: string, className?: string}[]} classes  the day's classes
 */
function exercisingPose(teamId, dateKey, classes = [], registry = REGISTRY) {
  const eligible = registry.filter((p) => {
    try { return p.eligible(classes || []); } catch (_) { return false; }
  });
  if (!eligible.length) return REGISTRY.find((p) => p.id === FALLBACK_POSE);
  const h = crypto.createHash('sha256').update(`${teamId}|${dateKey}`).digest();
  return eligible[h.readUInt32BE(0) % eligible.length];
}

/**
 * Mascot for a Team's day.
 * @param {object} p
 * @param {string} p.teamId
 * @param {{startMs: number, endMs: number, discipline?: string, className?: string}[]} p.classes
 *   EVERY class the Team shares today (including those at gyms the viewer lacks); "today"
 *   is already decided by the caller in each class's own zone.
 * @param {number} p.now   epoch ms
 * @param {string} p.zone  the viewer's IANA zone (night hours and the pose's date)
 */
function mascotFor({ teamId, classes = [], now, zone }) {
  const local = DateTime.fromMillis(now, { zone: zone || 'UTC' });
  const total = classes.length;
  const done = classes.filter((c) => c.endMs <= now).length;
  const inProgress = classes.filter((c) => c.startMs <= now && now < c.endMs).length;
  const night = local.hour < MORNING_HOUR || local.hour >= NIGHT_START_HOUR;
  let state;
  if (inProgress > 0) state = 'exercising';
  else if (night) state = 'sleeping';
  else if (total === 0) state = 'resting';
  else if (done === total) state = 'champion';
  else if (done === 0) state = 'warming';
  else state = 'cooling';
  // §5.4 ring: progress through ALL of the Team's classes today (every gym, "+N at other
  // gyms" included). A finished class counts 1, a class in progress its elapsed share,
  // so the ring moves during a class rather than jumping only when one ends (T-4).
  const progressOf = (c) => {
    if (c.endMs <= now) return 1;
    if (c.startMs > now) return 0;
    return Math.max(0, Math.min(1, (now - c.startMs) / Math.max(1, c.endMs - c.startMs)));
  };
  const ring = total ? Math.round((classes.reduce((s, c) => s + progressOf(c), 0) / total) * 1000) / 1000 : 0;
  if (state === 'exercising') {
    const p = exercisingPose(teamId, local.toISODate(), classes);
    return { state, pose: p.id, asset: p.asset, fit: false, ring };
  }
  const art = STATE_ART[state];
  return { state, pose: art.pose, asset: art.asset, fit: !!art.fit, ring };
}

/** A class's end instant, defaulting the duration when the row has none. */
const endMsOf = (startMs, durationMin) => startMs + (Number(durationMin) > 0 ? Number(durationMin) : DEFAULT_DURATION_MIN) * 60000;

module.exports = {
  REGISTRY, STATE_ART, STATES, FALLBACK_POSE, DEFAULT_DURATION_MIN,
  exercisingPose, mascotFor, endMsOf, isCycle, isBoxing,
};
