const assert = require('assert');
const { formatSpotLabel } = require('./spot-label');

assert.strictEqual(formatSpotLabel('jab-boxing', '24', 'Ground'), 'G 24');
assert.strictEqual(formatSpotLabel('jab-boxing', '13', 'Bag'), 'B 13');
assert.strictEqual(formatSpotLabel('jab-boxing', 'B13', 'Bag'), 'B13');
assert.strictEqual(formatSpotLabel('aarmy', '24', 'Ground'), '24');

// Per-studio spot type (spotMap.spotTypeStudios): BOXING on, TRAIN/unlisted off.
const { studioShowsSpotType } = require('./providers/spot-map');
const { getGymConfig } = require('./gyms.config');
const jab = getGymConfig('jab-boxing');
assert.strictEqual(studioShowsSpotType(jab, { id: '6286', name: 'BOXING' }), true);
assert.strictEqual(studioShowsSpotType(jab, { id: 'mock-room-BOXING', name: 'BOXING' }), true);
assert.strictEqual(studioShowsSpotType(jab, { id: '6282', name: 'TRAIN' }), false);
assert.strictEqual(studioShowsSpotType(jab, { id: '9', name: 'Other' }), false);
assert.strictEqual(studioShowsSpotType(jab, null), false);
assert.strictEqual(studioShowsSpotType(getGymConfig('aarmy'), { id: '6286', name: 'BOXING' }), false);

const MarianaTekProvider = require('./providers/marianatek');
const mt = Object.values(MarianaTekProvider).find((v) => typeof v === 'function') || MarianaTekProvider;
const prov = new mt(jab);
const layout = { spots: [{ id: '1', name: '8', spot_type: { name: 'Bag', is_primary: true } }] };
assert.strictEqual(prov.mapLayoutToSlots(layout, { id: '6286', name: 'BOXING' })[0].section, 'Bag');
assert.strictEqual(prov.mapLayoutToSlots(layout, { id: '6282', name: 'TRAIN' })[0].section, undefined);
assert.strictEqual(prov.mapLayoutToSlots(layout, { id: '6282', name: 'TRAIN' })[0].spotType, 'Bag');
console.log('spot-label checks passed');
