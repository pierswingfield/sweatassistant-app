// Row-group (whole-row preference) studio flag: gym config -> helper -> normalized studio.
const assert = require('assert');
const { getGymConfig } = require('./gyms.config');
const { studioHasRowGroups } = require('./providers/spot-map');
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
assert.strictEqual(studioHasRowGroups(psycle, { id: 108, name: 'Ride Studio 1' }), true);
assert.strictEqual(studioHasRowGroups(psycle, { id: 154, name: 'Reformer Studio' }), false);
assert.strictEqual(studioHasRowGroups(psycle, { id: 139, name: 'Barre Studio' }), false);
for (const name of ['BOXING', 'TRAIN', 'RECOVERY', 'Boxing Studio']) {
  assert.strictEqual(studioHasRowGroups(jab, { id: 6286, name }), false, name);
}

// Normalized shape: always a boolean, only true when explicitly true.
assert.strictEqual(makeStudio({ id: 1, name: 'a' }).rowGroups, false);
assert.strictEqual(makeStudio({ id: 1, name: 'a', rowGroups: 'yes' }).rowGroups, false);
assert.strictEqual(makeStudio({ id: 1, name: 'a', rowGroups: true }).rowGroups, true);
assert.strictEqual(makeMetadata({ studios: [{ id: 2, rowGroups: true }] }).studios[0].rowGroups, true);

console.log('row-groups: ok');
