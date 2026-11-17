// Header gym chips: which gyms have a LOADING problem. This is the only thing that raises the warning dot
// on the header ring. A balance of zero credits or "no membership" is a normal state, never a problem.
//
//   needs-relogin      the gym's login was rejected / expired (link status)
//   relogin-suspended  background re-login is suspended after repeated credential rejections
//   throttled          the provider is rate-limiting this gym (HTTP 429 on a read)
//   load-failed        a read for this gym failed (5xx / 503 / provider error)
//
// Link-derived kinds (needs-relogin, relogin-suspended) are recomputed from the link list; request-derived kinds
// are set/cleared by apiFetch as reads fail and succeed.

export const PROBLEM_KINDS = ['needs-relogin', 'relogin-suspended', 'throttled', 'load-failed'];
export const REQUEST_KINDS = ['throttled', 'load-failed'];

const problems = new Map(); // gymId -> Set<kind>
const subs = new Set();
const notify = () => subs.forEach((fn) => { try { fn(); } catch (_) {} });

export function setGymProblem(gymId, kind) {
  if (!gymId || !PROBLEM_KINDS.includes(kind)) return;
  const id = String(gymId);
  const set = problems.get(id) || new Set();
  if (set.has(kind)) return;
  set.add(kind); problems.set(id, set); notify();
}

export function clearGymProblem(gymId, kinds = PROBLEM_KINDS) {
  const id = String(gymId);
  const set = problems.get(id);
  if (!set) return;
  let changed = false;
  kinds.forEach((k) => { if (set.delete(k)) changed = true; });
  if (!set.size) problems.delete(id);
  if (changed) notify();
}

/** The most specific problem for a gym, or null. Login problems outrank load problems (they need the member). */
export function gymProblem(gymId) {
  const set = problems.get(String(gymId));
  if (!set) return null;
  return PROBLEM_KINDS.find((k) => set.has(k)) || null;
}

export function gymsWithProblems() { return [...problems.keys()]; }
export function onGymProblemChange(fn) { subs.add(fn); return () => subs.delete(fn); }
export function resetGymProblems() { problems.clear(); notify(); }

/** Fold the link list into the link-derived kinds. `links` = every linked gym (any status). */
export function syncLinkProblems(links) {
  (links || []).forEach((g) => {
    const id = g.gym_id || g.gymId || g.id;
    if (!id) return;
    const enabled = g.account_enabled !== 0 && g.account_enabled !== false;
    const relogin = enabled && g.status === 'needs_relogin';
    const suspended = enabled && !relogin && (g.relogin_suspended === 1 || g.relogin_suspended === true);
    relogin ? setGymProblem(id, 'needs-relogin') : clearGymProblem(id, ['needs-relogin']);
    suspended ? setGymProblem(id, 'relogin-suspended') : clearGymProblem(id, ['relogin-suspended']);
  });
}

/** Classify one finished READ for a gym: set or clear the request-derived kinds. */
export function noteGymResponse(gymId, status) {
  if (!gymId) return;
  if (status === 429) { setGymProblem(gymId, 'throttled'); clearGymProblem(gymId, ['load-failed']); return; }
  if (status >= 500) { setGymProblem(gymId, 'load-failed'); clearGymProblem(gymId, ['throttled']); return; }
  if (status >= 200 && status < 300) clearGymProblem(gymId, REQUEST_KINDS);
}

/** The ring's warning dot: true only when one of these chips has a loading problem. */
export function anyGymProblem(gymIds) { return (gymIds || []).some((id) => !!gymProblem(id)); }
