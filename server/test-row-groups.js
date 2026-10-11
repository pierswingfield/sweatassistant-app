// Row-group (whole-row preference) studio flag: gym config -> helper -> normalized studio.
const assert = require('assert');
const { getGymConfig } = require('./gyms.config');
const { studioHasRowGroups, studioMobileRotation, studioFrontSide } = require('./providers/spot-map');
const { makeStudio, makeMetadata } = require('./providers/normalize');

// Default OFF: no config, no studio, empty config.
assert.strictEqual(studioHasRowGroups(null, { id: 1, name: 'Ride' }), false);
assert.strictEqual(studioHasRowGroups({}, { id: 1, name: 'Ride' }), false);
assert.strictEqual(studioHasRowGroups({ spotMap: {} }, { id: 1, name: 'Ride' }), false);
assert.strictEqual(studioHasRowGroups({ spotMap: { rowGroupStudios: { ids: [1] } } }, null), false);

// ids compare as strings; names are case-insensitive; a bad pattern fails closed.
const byId = { spotMap: { rowGroupStudios: { ids: ['138'] } } };
assert.strictEqual(studioHasRowGroups(byId, { id: 138, name: 'x' }), true);
assert.strictEqual(studioHasRowGroups(byId, { id: '139', name: 'x' }), false);
const byName = { spotMap: { rowGroupStudios: { namePattern: '^ride' } } };
assert.strictEqual(studioHasRowGroups(byName, { id: 1, name: 'RIDE Studio 1' }), true);
assert.strictEqual(studioHasRowGroups(byName, { id: 1, name: 'Boxing Studio' }), false);
assert.strictEqual(studioHasRowGroups({ spotMap: { rowGroupStudios: { namePattern: '(' } } }, { id: 1, name: '(' }), false);

// Real config: Psycle ride studios keep it, others and JAB do not.
const psycle = getGymConfig('psycle-london');
const jab = getGymConfig('jab-boxing');
const aarmy = getGymConfig('aarmy');
assert.strictEqual(studioHasRowGroups(psycle, { id: 108, name: 'Ride Studio 1' }), true);
assert.strictEqual(studioHasRowGroups(psycle, { id: 154, name: 'Reformer Studio' }), false);
assert.strictEqual(studioHasRowGroups(psycle, { id: 139, name: 'Barre Studio' }), false);
for (const name of ['BOXING', 'TRAIN', 'RECOVERY', 'Boxing Studio']) {
  assert.strictEqual(studioHasRowGroups(jab, { id: 6286, name }), false, name);
}

// Mobile rotation is opt-in and keyed by the provider room policy, not client labels.
assert.strictEqual(studioMobileRotation(null, { id: 1, name: 'NoHo Bootcamp' }), 0);
assert.strictEqual(studioMobileRotation(aarmy, { id: 'bootcamp-a', name: 'NoHo Bootcamp' }), 90);
assert.strictEqual(studioMobileRotation(aarmy, { id: 'cycle-a', name: 'NoHo Cycle' }), 0);
// Live Aarmy metadata: room id 6184 is named plain "Bootcamp"; the Zoom room and Cycle must not rotate.
assert.strictEqual(studioMobileRotation(aarmy, { id: '6184', name: 'Bootcamp' }), 90);
assert.strictEqual(studioMobileRotation(aarmy, { id: 6184, name: 'anything' }), 90);
assert.strictEqual(studioMobileRotation(aarmy, { id: 'x', name: 'bootcamp' }), 90);
assert.strictEqual(studioMobileRotation(aarmy, { id: '6187', name: 'Bootcamp Zoom' }), 0);
assert.strictEqual(studioMobileRotation(aarmy, { id: '6182', name: 'Cycle' }), 90);
assert.strictEqual(studioMobileRotation(aarmy, { id: '6185', name: 'Cycle Live Stream' }), 0);

// Front side: config lookup, id match only for Cycle, default none.
assert.strictEqual(studioFrontSide(aarmy, { id: '6184', name: 'Bootcamp' }), 'top');
assert.strictEqual(studioFrontSide(aarmy, { id: 6182, name: 'Cycle' }), 'top');
assert.strictEqual(studioFrontSide(aarmy, { id: '6187', name: 'Bootcamp Zoom' }), null);
assert.strictEqual(studioFrontSide(aarmy, { id: '6185', name: 'Cycle Live Stream' }), null);
assert.strictEqual(studioFrontSide(psycle, { id: 108, name: 'Ride Studio 1' }), null);
assert.strictEqual(studioFrontSide(null, { id: 1 }), null);
assert.strictEqual(studioFrontSide({ spotMap: { frontStudios: { ids: ['1'], side: 'up' } } }, { id: 1 }), null);
assert.strictEqual(studioFrontSide({ spotMap: { frontStudios: { ids: ['1'], side: 'left' } } }, { id: 1 }), 'left');
assert.strictEqual(studioMobileRotation({ spotMap: { mobileRotationStudios: { ids: ['1'], degrees: 45 } } }, { id: 1 }), 0);

// Normalized shape: always a boolean, only true when explicitly true.
assert.strictEqual(makeStudio({ id: 1, name: 'a' }).rowGroups, false);
assert.strictEqual(makeStudio({ id: 1, name: 'a', rowGroups: 'yes' }).rowGroups, false);
assert.strictEqual(makeStudio({ id: 1, name: 'a', rowGroups: true }).rowGroups, true);
assert.strictEqual(makeMetadata({ studios: [{ id: 2, rowGroups: true }] }).studios[0].rowGroups, true);
assert.strictEqual(makeStudio({ id: 1, mobileRotation: 90 }).mobileRotation, 90);
assert.strictEqual(makeStudio({ id: 1, mobileRotation: 45 }).mobileRotation, 0);
assert.strictEqual(makeStudio({ id: 1, front: 'top' }).front, 'top');
assert.strictEqual(makeStudio({ id: 1, front: 'north' }).front, null);
assert.strictEqual(makeStudio({ id: 1 }).front, null);

console.log('row-groups: ok');
