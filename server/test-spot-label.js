const assert = require('assert');
const { formatSpotLabel } = require('./spot-label');

assert.strictEqual(formatSpotLabel('jab-boxing', '24', 'Ground'), 'G 24');
assert.strictEqual(formatSpotLabel('jab-boxing', '13', 'Bag'), 'B 13');
assert.strictEqual(formatSpotLabel('jab-boxing', 'B13', 'Bag'), 'B13');
assert.strictEqual(formatSpotLabel('aarmy', '24', 'Ground'), '24');
console.log('4/4 spot-label checks passed');
