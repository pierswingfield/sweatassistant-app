// C4-8: Apple Calendar treats webcal:// as http:// and warns "The connection is
// not secure". The Apple subscribe link must use the https form (webcals://);
// Google's link stays on http:// (it rejects the https variants, see buildLinks).

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { buildLinks } = require('./calendar');

const links = buildLinks('TOKEN_abc-123');
const path = '/api/calendar/TOKEN_abc-123.ics';
assert.ok(links.webcals.startsWith('webcals://'), `apple link must be webcals://, got ${links.webcals}`);
assert.ok(links.webcals.endsWith(path));
assert.ok(links.https.startsWith('https://') && links.https.endsWith(path), 'https fallback present');
assert.ok(links.webcal.startsWith('webcal://'), 'plain webcal kept for non-Apple clients');
assert.ok(links.google.startsWith('https://calendar.google.com/') && links.google.includes(`cid=http://`), 'google keeps its http:// feed form');
assert.ok(!links.google.includes('cid=https'), 'google must not get the https form');
// webcals host must match the https host so both point at the same feed.
assert.strictEqual(links.webcals.replace('webcals://', ''), links.https.replace('https://', ''));
console.log('✅ Apple subscribe link is webcals://; https and Google forms unchanged.');
