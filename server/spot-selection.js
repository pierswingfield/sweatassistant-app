// Deterministic candidate ordering for multi-spot Auto-Book. Provider adapters
// supply normalised coordinates; this module deliberately never infers geometry
// from user-facing labels, which are not spatial data.

const EPSILON = 1e-6;
const ROW_PRECISION = 1000;

function idOf(value) {
  return String(value);
}

function finiteCoordinate(slot) {
  return Number.isFinite(Number(slot?.x)) && Number.isFinite(Number(slot?.y));
}

function rowKey(slot) {
  return Math.round(Number(slot.y) * ROW_PRECISION) / ROW_PRECISION;
}

function appendUnique(target, values) {
  values.forEach((value) => {
    const id = idOf(value);
    if (!target.includes(id)) target.push(id);
  });
  return target;
}

function preferredIdsForMap(layoutSlots, preferredSlots = [], preferredRows = []) {
  const ids = [];
  appendUnique(ids, preferredSlots);
  const rows = new Set(preferredRows.map(Number).filter(Number.isFinite));
  if (rows.size) {
    layoutSlots.forEach((slot) => {
      if (Number.isFinite(Number(slot?.y)) && rows.has(Math.round(Number(slot.y) * 10) / 10)) {
        appendUnique(ids, [slot.id]);
      }
    });
  }
  return ids;
}

// A row is only treated as spatially reliable when it contributes at least two
// positive gaps. That lets us derive its normal pitch and reject a larger aisle
// gap, instead of pretending that arbitrary identifiers or a two-point layout
// establish adjacency.
function contiguousRuns(layoutSlots, availableSet, allowedSet = null) {
  const byRow = new Map();
  for (const slot of layoutSlots) {
    if (!finiteCoordinate(slot) || !availableSet.has(idOf(slot.id))) continue;
    if (allowedSet && !allowedSet.has(idOf(slot.id))) continue;
    const key = rowKey(slot);
    if (!byRow.has(key)) byRow.set(key, []);
    byRow.get(key).push(slot);
  }

  const rows = [...byRow.entries()].map(([key, slots]) => ({
    key,
    slots: slots.sort((a, b) => Number(a.x) - Number(b.x) || idOf(a.id).localeCompare(idOf(b.id))),
  }));
  const gaps = rows.flatMap(({ slots }) => slots.slice(1).map((slot, index) => Number(slot.x) - Number(slots[index].x)).filter((gap) => gap > EPSILON));
  if (gaps.length < 2) return [];
  const pitch = Math.min(...gaps);
  if (!Number.isFinite(pitch) || pitch <= EPSILON) return [];
  const maxAdjacentGap = pitch * 1.5 + EPSILON;

  const runs = [];
  rows.forEach(({ key, slots }) => {
    let run = [];
    slots.forEach((slot, index) => {
      if (index === 0 || Number(slot.x) - Number(slots[index - 1].x) <= maxAdjacentGap) {
        run.push(slot);
      } else {
        if (run.length >= 2) runs.push({ row: key, slots: run });
        run = [slot];
      }
    });
    if (run.length >= 2) runs.push({ row: key, slots: run });
  });
  return runs;
}

function centreOf(slots) {
  if (!slots.length || slots.some((slot) => !finiteCoordinate(slot))) return null;
  return {
    x: slots.reduce((sum, slot) => sum + Number(slot.x), 0) / slots.length,
    y: slots.reduce((sum, slot) => sum + Number(slot.y), 0) / slots.length,
  };
}

function distanceToAnchors(slot, anchors) {
  if (!finiteCoordinate(slot) || !anchors.length) return Infinity;
  return Math.min(...anchors.map((anchor) => Math.hypot(Number(slot.x) - anchor.x, Number(slot.y) - anchor.y)));
}

function orderedIdsFromRuns(runs, anchors, providerIndex) {
  return [...runs]
    .sort((a, b) => {
      // Larger runs first: a viable group must never lose to a smaller one just
      // because it happens to be marginally nearer the preferred map.
      const size = b.slots.length - a.slots.length;
      if (size) return size;
      const ac = centreOf(a.slots);
      const bc = centreOf(b.slots);
      const distance = (ac ? distanceToAnchors(ac, anchors) : Infinity) - (bc ? distanceToAnchors(bc, anchors) : Infinity);
      if (Math.abs(distance) > EPSILON) return distance;
      return Math.min(...a.slots.map((slot) => providerIndex.get(idOf(slot.id)))) - Math.min(...b.slots.map((slot) => providerIndex.get(idOf(slot.id))));
    })
    .flatMap((run) => run.slots.map((slot) => idOf(slot.id)));
}

/**
 * Plans a bounded, deterministic attempt order. It only reorders available
 * candidates; the scheduler still preserves partial successes if later provider
 * POSTs fail.
 */
function planAutoBookSlots({ layoutSlots = [], availableSlotIds = [], preferredSlots = [], preferredRows = [], bookAny = true, prioritizeTogether = false }) {
  const available = availableSlotIds.map(idOf);
  const availableSet = new Set(available);
  const providerIndex = new Map(available.map((id, index) => [id, index]));
  const mapPreferred = preferredIdsForMap(layoutSlots, preferredSlots, preferredRows);
  const preferredSet = new Set(mapPreferred);
  const preferredAvailable = mapPreferred.filter((id) => availableSet.has(id));
  const layoutById = new Map(layoutSlots.map((slot) => [idOf(slot.id), slot]));
  const anchors = preferredAvailable.map((id) => layoutById.get(id)).filter(finiteCoordinate).map((slot) => ({ x: Number(slot.x), y: Number(slot.y) }));
  const output = [];

  // Preferred contiguous runs are always first, whether or not the user turns
  // on the wider togetherness preference. A selected map remains their first
  // choice; only the explicit option can widen the search beyond it.
  const preferredRuns = contiguousRuns(layoutSlots, availableSet, preferredSet);
  appendUnique(output, orderedIdsFromRuns(preferredRuns, anchors, providerIndex));

  if (prioritizeTogether && bookAny) {
    const allRuns = contiguousRuns(layoutSlots, availableSet);
    appendUnique(output, orderedIdsFromRuns(allRuns, anchors, providerIndex));
  }

  appendUnique(output, preferredAvailable);

  if (bookAny) {
    const remaining = available.filter((id) => !output.includes(id));
    const canRankByDistance = anchors.length > 0 && remaining.every((id) => finiteCoordinate(layoutById.get(id)));
    if (canRankByDistance) {
      remaining.sort((a, b) => {
        const distance = distanceToAnchors(layoutById.get(a), anchors) - distanceToAnchors(layoutById.get(b), anchors);
        return Math.abs(distance) > EPSILON ? distance : providerIndex.get(a) - providerIndex.get(b);
      });
    }
    appendUnique(output, remaining);
  }

  return output;
}

/**
 * Candidate order for a companion place (a named guest) once the primary's ACTUAL spot is known.
 * With togetherness the whole group was planned together, but the primary may have landed elsewhere
 * than planned, so the companion is re-planned around where the primary really is: nearest free spot
 * first (adjacent when one exists), ties by provider order. Without togetherness (or without usable
 * coordinates) it falls back to the normal plan minus the excluded spots.
 */
function planCompanionSlots({ layoutSlots = [], availableSlotIds = [], primarySlotId, excludeIds = [], preferredSlots = [], preferredRows = [], bookAny = true, prioritizeTogether = false }) {
  const exclude = new Set([...excludeIds, primarySlotId].filter((v) => v != null).map(idOf));
  const normal = planAutoBookSlots({ layoutSlots, availableSlotIds, preferredSlots, preferredRows, bookAny, prioritizeTogether }).filter((id) => !exclude.has(id));
  if (!prioritizeTogether) return normal;
  const byId = new Map(layoutSlots.map((slot) => [idOf(slot.id), slot]));
  const primary = byId.get(idOf(primarySlotId));
  if (!primary || !finiteCoordinate(primary)) return normal;
  const index = new Map(normal.map((id, i) => [id, i]));
  const pool = availableSlotIds.map(idOf).filter((id) => !exclude.has(id) && finiteCoordinate(byId.get(id)));
  if (pool.length !== availableSlotIds.map(idOf).filter((id) => !exclude.has(id)).length) return normal;
  const dist = (id) => Math.hypot(Number(byId.get(id).x) - Number(primary.x), Number(byId.get(id).y) - Number(primary.y));
  return pool.sort((a, b) => (Math.abs(dist(a) - dist(b)) > EPSILON ? dist(a) - dist(b) : (index.get(a) ?? 1e9) - (index.get(b) ?? 1e9)));
}

module.exports = { planAutoBookSlots, planCompanionSlots, preferredIdsForMap, contiguousRuns };
