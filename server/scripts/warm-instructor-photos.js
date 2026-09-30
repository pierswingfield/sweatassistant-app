#!/usr/bin/env node
// Warm the F-15 instructor photo cache for every enabled gym, through the same
// pipeline the route uses. Run: docker exec psycle-app-dev node server/scripts/warm-instructor-photos.js
const { listEnabledGyms } = require('../gyms.config');
const { getProvider } = require('../providers');
const { makeMetadata } = require('../providers/normalize');
const photos = require('../instructor-photo');
const fs = require('fs');
const path = require('path');

const CONCURRENCY = 4;
const ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enumerate() {
  const items = new Map();
  for (const gym of listEnabledGyms()) {
    try {
      const provider = getProvider(gym.id);
      const start = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 21 * 864e5).toISOString().slice(0, 10);
      const raw = await provider.fetchMetadata({ startDate: start, endDate: end }, null);
      const meta = raw && raw.instructors && raw.instructors[0] && /instructor-photo/.test(raw.instructors[0].thumbUrl || '')
        ? raw : makeMetadata({ ...raw, gymId: gym.id });
      for (const i of meta.instructors || []) {
        const m = /v=([a-f0-9]{64})/.exec(i.thumbUrl || '');
        if (m) items.set(`${gym.id}:${i.id}`, { gymId: gym.id, id: String(i.id), name: i.name, version: m[1], fullVersion: (/v=([a-f0-9]{64})/.exec(i.imageUrl || '') || m)[1] });
      }
    } catch (err) { console.error(`enumerate ${gym.id} failed: ${err.message}`); }
  }
  return [...items.values()];
}

async function warmOne(it) {
  let ok = 0, skipped = 0;
  for (const [variant, version] of [['thumb', it.version], ['full', it.fullVersion]]) {
    if (fs.existsSync(path.join(photos.CACHE_DIR, `${version}-${variant}.webp`))) { skipped++; continue; }
    let res = null;
    for (let a = 1; a <= ATTEMPTS; a++) {
      res = await photos.getPhoto({ provider: getProvider(it.gymId), instructorId: it.id, variant, version });
      if (!res || !res.transient) break;
      await sleep(1000 * a);
    }
    if (res && res.body) ok++; else return { failed: true };
  }
  return ok ? { ok: true } : { skipped: true };
}

(async () => {
  const items = await enumerate();
  const c = { ok: 0, skipped: 0, failed: 0 }; const failed = [];
  let idx = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (idx < items.length) {
      const it = items[idx++];
      const r = await warmOne(it).catch(() => ({ failed: true }));
      if (r.failed) { c.failed++; failed.push(`${it.gymId}:${it.name || it.id}`); } else if (r.ok) c.ok++; else c.skipped++;
    }
  }));
  console.log(`warm-instructor-photos: ok=${c.ok} skipped=${c.skipped} failed=${c.failed}${failed.length ? ' [' + failed.join(', ') + ']' : ''}`);
  process.exit(c.failed ? 1 : 0);
})();
