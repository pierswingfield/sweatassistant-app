// U1-19b — server/class-name.js is a CJS mirror of client/src/class-name.js (the
// image builds client and server separately). This pins the two to identical
// output over a corpus, and pins the user-visible rule on the string the member
// reported: "TRAIN - Lower (Focus)".
if (!process.env.ENCRYPTION_KEY) process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');
const server = require('./class-name');

const CORPUS = [
  ['TRAIN - Lower (Focus)', 'TRAIN - Lower (Focus)'],
  ['TRAIN - Lower (Focus)', 'TRAIN'],
  ['TRAIN - Upper (Focus)', 'Train'],
  ['BOXING Core & Power', 'BOXING'],
  ['RIDE: Signature 45', 'Ride'],
  ['Barre 55', 'Barre'],
  ['BOXING', 'BOXING'],
  ['RECOVERY (Members)', 'RECOVERY'],
  ['Signature 45', 'Ride'],
  ['HIIT Burn', ''],
  ['', 'Ride'],
];

(async () => {
  const client = await import(pathToFileURL(path.join(__dirname, '..', 'client', 'src', 'class-name.js')).href);
  let failed = 0;
  const t = (name, fn) => { try { fn(); console.log(`✅ ${name}`); } catch (e) { failed++; console.error(`❌ ${name}\n   ${e.message}`); } };

  t('server and client rules agree on every corpus row', () => {
    for (const [n, d] of CORPUS) {
      assert.strictEqual(server.cleanClassName(n, d), client.cleanClassNameWith(n, d, ''), `${n} | ${d}`);
      assert.strictEqual(server.disciplineHead(d), client.disciplineHead(d), `head ${d}`);
    }
  });
  t('the reported string reads "Lower (Focus)" and its group token is "TRAIN"', () => {
    assert.strictEqual(server.cleanClassName('TRAIN - Lower (Focus)', 'TRAIN - Lower (Focus)'), 'Lower (Focus)');
    assert.strictEqual(server.groupToken('TRAIN - Lower (Focus)'), 'TRAIN');
  });
  t('a class that IS its discipline keeps its name (no blank cell)', () => {
    assert.strictEqual(server.cleanClassName('BOXING', 'BOXING'), 'Boxing');
  });
  process.exit(failed ? 1 : 0);
})();
