// Link shapes the client relies on. The Apple subscribe button uses plain webcal://: it is the only
// scheme iOS/macOS register, and Safari on iOS answers webcals:// with "invalid address". The
// webcals:// form is still published (C4-8 warning workaround) but must not be the Apple button's
// target. Google's link stays on http:// (it rejects the https variants, see buildLinks).

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
assert.ok(links.webcal.startsWith('webcal://') && links.webcal.endsWith(path), 'plain webcal is the Apple subscribe link');
assert.ok(links.google.startsWith('https://calendar.google.com/') && links.google.includes(`cid=http://`), 'google keeps its http:// feed form');
assert.ok(!links.google.includes('cid=https'), 'google must not get the https form');
// webcals host must match the https host so both point at the same feed.
assert.strictEqual(links.webcals.replace('webcals://', ''), links.https.replace('https://', ''));
console.log('✅ webcal, webcals, https and Google link forms are all published.');
