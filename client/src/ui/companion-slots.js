// Nearest-free-spot ordering for a companion place (a named guest) once the primary's ACTUAL spot is
// known: the client twin of server/spot-selection.js planCompanionSlots (Quick-Book books the guest from
// the browser). Nearest by layout x/y first, adjacent when one is free; input order breaks ties. Without
// usable coordinates for the primary and every candidate, the input order is returned unchanged.
export function orderCompanionSlots({ slots = [], candidates = [], primarySlotId } = {}) {
  const at = new Map(slots.map((s) => [String(s.id), s]));
  const ok = (s) => s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y));
  const primary = at.get(String(primarySlotId));
  if (!ok(primary) || !candidates.every((id) => ok(at.get(String(id))))) return [...candidates];
  const d = (id) => Math.hypot(Number(at.get(String(id)).x) - Number(primary.x), Number(at.get(String(id)).y) - Number(primary.y));
  return candidates.map((id, i) => ({ id, i, d: d(id) })).sort((a, b) => (Math.abs(a.d - b.d) > 1e-9 ? a.d - b.d : a.i - b.i)).map((c) => c.id);
}

// Quick-Book "Prioritise spots together" for SEVERAL OWN spots (no guest): client twin of the
// together ordering in server/spot-selection.js. Picks the tightest set of `count` free candidates
// (anchor + its nearest neighbours; smallest total pairwise distance) and returns the candidates
// reordered so that set comes first, anchor first, then the rest as fallbacks. A set anchored on a
// preferred spot (the first `preferredCount` candidates) wins unless it is looser than 1.25x the
// best set anywhere. Without usable x/y for every candidate the input order is returned unchanged.
export function orderTogetherSlots({ slots = [], candidates = [], count = 2, preferredCount = 0 } = {}) {
  if (count < 2 || candidates.length < count) return [...candidates];
  const at = new Map(slots.map((s) => [String(s.id), s]));
  const ok = (s) => s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y));
  if (!candidates.every((id) => ok(at.get(String(id))))) return [...candidates];
  const dist = (a, b) => Math.hypot(Number(at.get(String(a)).x) - Number(at.get(String(b)).x), Number(at.get(String(a)).y) - Number(at.get(String(b)).y));
  const groups = candidates.map((anchor, i) => {
    const near = candidates.filter((id) => id !== anchor)
      .map((id, j) => ({ id, d: dist(anchor, id), j }))
      .sort((a, b) => (Math.abs(a.d - b.d) > 1e-9 ? a.d - b.d : a.j - b.j))
      .slice(0, count - 1).map((n) => n.id);
    const set = [anchor, ...near];
    let total = 0;
    for (let a = 0; a < set.length; a++) for (let b = a + 1; b < set.length; b++) total += dist(set[a], set[b]);
    return { i, set, total };
  });
  const best = Math.min(...groups.map((g) => g.total));
  const pick = groups.find((g) => g.i < preferredCount && g.total <= best * 1.25 + 1e-9)
    || groups.find((g) => g.total <= best + 1e-9);
  return [...pick.set, ...candidates.filter((id) => !pick.set.includes(id))];
}
