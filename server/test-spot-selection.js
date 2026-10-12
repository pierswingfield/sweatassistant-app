const assert = require('assert');
const { planAutoBookSlots, planCompanionSlots } = require('./spot-selection');

const slots = [
  { id: 'alpha', label: '37458', x: 0, y: 0 },
  { id: 'bravo', label: '37457', x: 1, y: 0 },
  { id: 'charlie', label: '37456', x: 2, y: 0 },
  { id: 'delta', label: '37455', x: 10, y: 0 }, // aisle after charlie
  { id: 'echo', label: '37454', x: 11, y: 0 },
  { id: 'foxtrot', label: '1', x: 0, y: 1 },
  { id: 'golf', label: '2', x: 1, y: 1 },
  { id: 'hotel', label: '3', x: 2, y: 1 },
];
const all = slots.map((slot) => slot.id);

// A wholly preferred contiguous group wins before equally preferred isolated
// candidates. Labels deliberately descend while physical x ascends.
let plan = planAutoBookSlots({ layoutSlots: slots, availableSlotIds: all, preferredSlots: ['delta', 'alpha', 'bravo', 'charlie'], bookAny: false });
assert.deepStrictEqual(plan.slice(0, 3), ['alpha', 'bravo', 'charlie']);
assert.ok(!plan.includes('echo'), 'bookAny=false never crosses the preferred boundary');

// Togetherness can widen after the selected map; it finds a contiguous run in
// a different row before trying the non-adjacent fallback slot.
plan = planAutoBookSlots({ layoutSlots: slots, availableSlotIds: all, preferredSlots: ['delta', 'alpha'], bookAny: true, prioritizeTogether: true });
assert.deepStrictEqual(plan.slice(0, 3), ['alpha', 'bravo', 'charlie']);
assert.ok(plan.indexOf('echo') > plan.indexOf('charlie'));

// The normal preference keeps selected locations ahead of outside-row groups.
plan = planAutoBookSlots({ layoutSlots: slots, availableSlotIds: all, preferredSlots: ['delta', 'alpha'], bookAny: true, prioritizeTogether: false });
assert.deepStrictEqual(plan.slice(0, 2), ['delta', 'alpha']);
assert.ok(plan.indexOf('foxtrot') > plan.indexOf('alpha'));

// A partially unavailable preferred run retains its nearby remaining choice and
// then chooses the closest available fallback rather than a provider-order slot.
plan = planAutoBookSlots({ layoutSlots: slots, availableSlotIds: ['alpha', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'], preferredSlots: ['alpha', 'bravo', 'charlie'], bookAny: true });
assert.deepStrictEqual(plan.slice(0, 2), ['alpha', 'charlie']);
assert.strictEqual(plan[2], 'foxtrot', 'nearest fallback is chosen after remaining preferred slots');

// Without enough coordinate evidence, preserve map/provider ordering rather
// than claiming the numeric labels are adjacent.
plan = planAutoBookSlots({
  layoutSlots: [{ id: 'x', label: '1' }, { id: 'y', label: '999' }],
  availableSlotIds: ['y', 'x', 'z'], preferredSlots: ['x', 'y'], bookAny: true, prioritizeTogether: true,
});
assert.deepStrictEqual(plan, ['x', 'y', 'z']);

// Companion (guest) place: re-planned around the primary's ACTUAL spot, nearest free first.
let comp = planCompanionSlots({ layoutSlots: slots, availableSlotIds: all, primarySlotId: 'bravo', preferredSlots: ['alpha', 'bravo', 'charlie'], bookAny: true, prioritizeTogether: true });
assert.ok(!comp.includes('bravo'), 'never the primary own spot');
assert.ok(['alpha', 'charlie', 'golf'].includes(comp[0]), 'adjacent to the primary first');
// Plan said alpha+bravo, but the primary landed on echo (far side of the aisle): guest goes beside echo, not beside alpha.
comp = planCompanionSlots({ layoutSlots: slots, availableSlotIds: all, primarySlotId: 'echo', excludeIds: ['echo'], preferredSlots: ['alpha', 'bravo'], bookAny: true, prioritizeTogether: true });
assert.strictEqual(comp[0], 'delta');
// Taken spots are excluded; without togetherness the normal plan order is kept.
comp = planCompanionSlots({ layoutSlots: slots, availableSlotIds: all, primarySlotId: 'alpha', excludeIds: ['bravo'], preferredSlots: ['alpha', 'bravo', 'charlie'], bookAny: true, prioritizeTogether: false });
assert.deepStrictEqual(comp.slice(0, 1), ['charlie']);
assert.ok(!comp.includes('bravo') && !comp.includes('alpha'));
// No coordinates: fall back to the normal plan minus the primary.
comp = planCompanionSlots({ layoutSlots: [{ id: 'x' }, { id: 'y' }], availableSlotIds: ['x', 'y', 'z'], primarySlotId: 'x', preferredSlots: ['x', 'y'], bookAny: true, prioritizeTogether: true });
assert.deepStrictEqual(comp, ['y', 'z']);

console.log('✅ spatial candidate planner: preferred groups, together widening, boundaries, proximity, and no-geometry fallback.');
