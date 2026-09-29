// F-15 — tests for the same-origin photo cache's security and isolation rules.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { versionFor, getPhoto } = require('./instructor-photo');
const { makeMetadata, makeEvent } = require('./providers/normalize');

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweat-f15-'));

function imageResponse(buffer) {
  return new Response(buffer, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(buffer.length) } });
}

check('generates a WebP once and serves the disk cache without an upstream request', async () => {
  const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#f05a28' } }).png().toBuffer();
  const sourceUrl = 'https://images.example.test/a.png';
  let lookups = 0;
  let fetches = 0;
  const provider = { findInstructorPhoto: async (id) => { lookups++; return id === 'coach-a' ? { imageUrl: sourceUrl } : null; } };
  const fetchImpl = async () => { fetches++; return imageResponse(png); };
  const opts = { provider, instructorId: 'coach-a', variant: 'thumb', version: versionFor(sourceUrl), cacheDir, fetchImpl };
  const first = await getPhoto(opts);
  assert.ok(first && first.body.length > 0);
  assert.strictEqual(first.cacheStatus, 'MISS');
  assert.strictEqual((await sharp(first.body).metadata()).format, 'webp');
  const second = await getPhoto(opts);
  assert.strictEqual(second.cacheStatus, 'HIT');
  assert.deepStrictEqual(second.body, first.body);
  assert.strictEqual(lookups, 1);
  assert.strictEqual(fetches, 1);
});

check('unknown instructor and a cross-gym source-version mismatch never fetch', async () => {
  let fetches = 0;
  const fetchImpl = async () => { fetches++; throw new Error('must not fetch'); };
  const unknown = await getPhoto({
    provider: { findInstructorPhoto: async () => null }, instructorId: 'missing', variant: 'full',
    version: versionFor('https://images.example.test/missing.png'), cacheDir, fetchImpl,
  });
  assert.strictEqual(unknown, null);
  const aUrl = 'https://images.example.test/gym-a.png';
  const collision = await getPhoto({
    provider: { findInstructorPhoto: async () => ({ imageUrl: 'https://images.example.test/gym-b.png' }) },
    instructorId: 'same-provider-id', variant: 'full', version: versionFor(aUrl), cacheDir, fetchImpl,
  });
  assert.strictEqual(collision, null);
  assert.strictEqual(fetches, 0);
});

check('non-image upstream responses are rejected and do not leave a cache file', async () => {
  const sourceUrl = 'https://images.example.test/not-an-image';
  const version = versionFor(sourceUrl);
  const result = await getPhoto({
    provider: { findInstructorPhoto: async () => ({ imageUrl: sourceUrl }) }, instructorId: 'bad-content', variant: 'full', version, cacheDir,
    fetchImpl: async () => new Response('<html>no</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  assert.strictEqual(result, null);
  assert.ok(!fs.existsSync(path.join(cacheDir, `${version}-full.webp`)));
});

check('normalized metadata and events expose versioned same-origin URLs for both variants', () => {
  const sourceUrl = 'https://images.example.test/coach.png';
  const meta = makeMetadata({ gymId: 'gym-a', instructors: [{ id: '7', name: 'Coach', imageUrl: sourceUrl }] });
  assert.match(meta.instructors[0].imageUrl, /^\/api\/instructor-photo\/gym-a\/7\?size=full&v=[a-f0-9]{64}$/);
  assert.match(meta.instructors[0].thumbUrl, /^\/api\/instructor-photo\/gym-a\/7\?size=thumb&v=[a-f0-9]{64}$/);
  const event = makeEvent({ id: 'class', gymId: 'gym-b', instructors: [{ id: '7', name: 'Coach', thumbUrl: sourceUrl }] });
  assert.match(event.instructors[0].thumbUrl, /^\/api\/instructor-photo\/gym-b\/7\?size=thumb&v=[a-f0-9]{64}$/);
});

(async () => {
  let passed = 0;
  const failures = [];
  for (const { name, fn } of checks) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.stack || err.message}`); }
  }
  fs.rmSync(cacheDir, { recursive: true, force: true });
  if (failures.length) {
    console.error(`✗ ${failures.length}/${checks.length} instructor-photo checks FAILED.`);
    process.exit(1);
  }
  console.log(`🎉 ${passed}/${checks.length} instructor-photo checks passed.`);
})();
