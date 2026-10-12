// Pure planning for GROUP Auto-Upgrade: several of one member's reservations on one
// class, moved only TOGETHER. No I/O, no gym knowledge (geometry comes from the
// adapter's layout; labels are never used as spatial data, as in spot-selection.js).
//
// "Better" is defined on preferred-map rank, not on a sum: after sorting each set's
// ranks ascending, the target must be at-least-as-good in EVERY position and strictly
// better in one (Pareto). A sum could trade a member's best seat for two mediocre
// ones. And the target must be at least as TOGETHER as the current set (fewer
// adjacency components, or the same count with no wider spread), so an upgrade can
// never split or loosen the group.

const { contiguousRuns } = require('./spot-selection');

const EPS = 1e-6;
const MAX_POOL = 22;
const MAX_COMBOS = 400000;

const idOf = (v) => String(v);
const hasXY = (s) => s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y));

/** Adjacent pairs ("a|b", sorted) derived from the FULL layout's seat pitch. */
function adjacencyOf(layoutSlots) {
  const all = new Set(layoutSlots.map((s) => idOf(s.id)));
  const pairs = new Set();
  for (const run of contiguousRuns(layoutSlots, all)) {
    for (let i = 1; i < run.slots.length; i++) {
      const a = idOf(run.slots[i - 1].id), b = idOf(run.slots[i].id);
      pairs.add(a < b ? `${a}|${b}` : `${b}|${a}`);
    }
  }
  return pairs;
}

/** { components, spread } or null when any seat lacks coordinates (unknown geometry). */
function togetherness(ids, byId, adjacency) {
  const slots = ids.map((id) => byId.get(idOf(id)));
  if (slots.some((s) => !hasXY(s))) return null;
  const parent = ids.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = idOf(ids[i]), b = idOf(ids[j]);
      if (adjacency.has(a < b ? `${a}|${b}` : `${b}|${a}`)) parent[find(i)] = find(j);
    }
  }
  const components = new Set(ids.map((_, i) => find(i))).size;
  let spread = 0;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      spread = Math.max(spread, Math.hypot(Number(slots[i].x) - Number(slots[j].x), Number(slots[i].y) - Number(slots[j].y)));
    }
  }
  return { components, spread };
}

const atLeastAsTogether = (t, c) => t.components < c.components || (t.components === c.components && t.spread <= c.spread + EPS);
const strictlyMoreTogether = (t, c) => t.components < c.components || (t.components === c.components && t.spread < c.spread - EPS);

function rankVector(ids, rankOf) {
  return ids.map((id) => rankOf(idOf(id))).sort((a, b) => a - b);
}
/** -1 worse somewhere; 0 equal; 2 never worse and strictly better somewhere. */
function dominance(target, current) {
  let strict = false;
  for (let i = 0; i < target.length; i++) {
    if (target[i] > current[i]) return -1;
    if (target[i] < current[i]) strict = true;
  }
  return strict ? 2 : 0;
}

function* combinations(items, k) {
  const idx = [];
  function* rec(start) {
    if (idx.length === k) { yield idx.map((i) => items[i]); return; }
    for (let i = start; i <= items.length - (k - idx.length); i++) {
      idx.push(i);
      yield* rec(i + 1);
      idx.pop();
    }
  }
  yield* rec(0);
}

/**
 * Pair each member that must move with a destination, nearest first (deterministic).
 * Members already sitting on a target seat stay put.
 */
function assignMoves(currentIds, targetIds, byId) {
  const cur = currentIds.map(idOf), tgt = targetIds.map(idOf);
  const movers = cur.filter((id) => !tgt.includes(id));
  const dests = tgt.filter((id) => !cur.includes(id));
  const pairs = [];
  for (const f of movers) for (const t of dests) {
    const a = byId.get(f), b = byId.get(t);
    pairs.push({ from: f, to: t, d: hasXY(a) && hasXY(b) ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity });
  }
  pairs.sort((p, q) => p.d - q.d || p.from.localeCompare(q.from) || p.to.localeCompare(q.to));
  const usedF = new Set(), usedT = new Set(), moves = [];
  for (const p of pairs) {
    if (usedF.has(p.from) || usedT.has(p.to)) continue;
    usedF.add(p.from); usedT.add(p.to); moves.push({ from: p.from, to: p.to });
  }
  return moves;
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] - b[i];
  }
  return 0;
}

/**
 * @param {object} o
 * @param {Array} o.layoutSlots            adapter layout slots (id,x,y)
 * @param {string[]} o.availableSlotIds    seats free right now
 * @param {string[]} o.currentSlotIds      seats the group holds
 * @param {string[]} o.preferredOrder      preferred seat ids, best first (map slots + row seats)
 * @param {boolean} [o.prioritizeTogether] the Auto-Book "together" flag carried onto the monitor
 * @returns {null | {targetSlotIds:string[], moves:{from:string,to:string}[]}} null = no safe improvement
 */
function planGroupUpgrade({ layoutSlots = [], availableSlotIds = [], currentSlotIds = [], preferredOrder = [], prioritizeTogether = false }) {
  const n = currentSlotIds.length;
  if (n < 2) return null;
  const byId = new Map(layoutSlots.map((s) => [idOf(s.id), s]));
  const order = preferredOrder.map(idOf);
  const L = order.length;
  const rankMap = new Map(order.map((id, i) => [id, i]));
  const rankOf = (id) => (rankMap.has(id) ? rankMap.get(id) : L);

  const current = currentSlotIds.map(idOf);
  const adjacency = adjacencyOf(layoutSlots);
  const curTogether = togetherness(current, byId, adjacency);
  if (!curTogether) return null; // unknown geometry: never move a group blind
  const curRanks = rankVector(current, rankOf);

  const curSet = new Set(current);
  const avail = new Set(availableSlotIds.map(idOf));
  // Only seats that can improve a set (preferred) or already belong to it.
  const pool = [...new Set([...order.filter((id) => byId.has(id) && (avail.has(id) || curSet.has(id))), ...current])]
    .sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b));
  const capped = pool.length > MAX_POOL ? [...new Set([...pool.slice(0, MAX_POOL), ...current])] : pool;
  if (capped.length < n) return null;

  let best = null, seen = 0;
  for (const combo of combinations(capped, n)) {
    if (++seen > MAX_COMBOS) break;
    if (combo.every((id) => curSet.has(id))) continue;
    // Every seat must be genuinely takeable: free now, or already ours.
    if (combo.some((id) => !avail.has(id) && !curSet.has(id))) continue;
    const dom = dominance(rankVector(combo, rankOf), curRanks);
    if (dom < 0) continue;
    const tog = togetherness(combo, byId, adjacency);
    if (!tog || !atLeastAsTogether(tog, curTogether)) continue;
    const improved = dom === 2 || (prioritizeTogether && strictlyMoreTogether(tog, curTogether));
    if (!improved) continue;
    const sum = combo.reduce((a, id) => a + rankOf(id), 0);
    const key = prioritizeTogether ? [tog.components, tog.spread, sum] : [sum, tog.components, tog.spread];
    const sorted = [...combo].sort().join(',');
    if (!best || cmpKey(key, best.key) < 0 || (cmpKey(key, best.key) === 0 && sorted < best.sorted)) {
      best = { key, sorted, combo };
    }
  }
  if (!best) return null;
  return {
    targetSlotIds: best.combo,
    moves: assignMoves(current, best.combo, byId).sort((a, b) => rankOf(a.to) - rankOf(b.to)),
  };
}

module.exports = { planGroupUpgrade, assignMoves, togetherness, adjacencyOf, dominance };
