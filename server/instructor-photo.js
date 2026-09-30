// F-15 — same-origin instructor photo cache.
//
// The public route never accepts an upstream URL.  Instead, it receives an
// instructor id plus the SHA-256 version that the normalizer derived from an
// adapter-supplied source URL.  A cached version can be served without any
// provider call; a miss is resolved through the provider and must match that
// version before it is fetched.  That preserves the SSRF boundary while also
// allowing a changed provider URL to produce a new immutable client URL.

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const CACHE_DIR = process.env.INSTRUCTOR_PHOTO_CACHE_DIR || '/data/instructor-photos';
const MAX_CACHE_BYTES = 500 * 1024 * 1024;
const MAX_UPSTREAM_BYTES = 5 * 1024 * 1024;
const LOOKUP_TIMEOUT_MS = 8_000;
const UPSTREAM_TIMEOUT_MS = 20_000; // body download budget, separate from the lookup
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
const negative = new Map(); // key -> expiry; genuinely no photo / permanent upstream rejection
const TRANSIENT = Object.freeze({ transient: true });

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
const VARIANTS = {
  thumb: { width: 96, height: 96, quality: 78 },
  full: { width: 480, height: 480, quality: 82 },
};
const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

const inFlight = new Map();
const stats = { hits: 0, misses: 0, coalesced: 0, generated: 0, failures: 0, upstreamMs: 0, upstreamRequests: 0 };

function versionFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}

function validVersion(version) {
  return typeof version === 'string' && /^[a-f0-9]{64}$/.test(version);
}

function cachePath(cacheDir, version, variant) {
  return path.join(cacheDir, `${version}-${variant}.webp`);
}

async function readCached(filePath) {
  try {
    const data = await fs.readFile(filePath);
    // mtime doubles as our simple LRU clock.  Failure to touch is harmless:
    // the image still serves and may be evicted a little earlier.
    fs.utimes(filePath, new Date(), new Date()).catch(() => {});
    return data;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

async function fetchBounded(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const started = Date.now();
  try {
    stats.upstreamRequests++;
    // Do not follow redirects. A provider-controlled image URL is allowlisted
    // by lookup; a redirect destination is not.
    const res = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
    stats.upstreamMs += Date.now() - started;
    const type = (res.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
    const advertised = Number(res.headers.get('content-length'));
    if (res.status === 429 || res.status >= 500) {
      const e = new Error('Photo upstream throttled or unavailable.'); e.transient = true; throw e;
    }
    if (!res.ok || !ALLOWED_CONTENT_TYPES.has(type) || (Number.isFinite(advertised) && advertised > MAX_UPSTREAM_BYTES)) {
      throw new Error('Photo upstream response was not an allowed image.');
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > MAX_UPSTREAM_BYTES) throw new Error('Photo upstream response exceeded size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

async function prune(cacheDir, maxBytes) {
  let files;
  try { files = await fs.readdir(cacheDir, { withFileTypes: true }); } catch (_) { return; }
  const entries = [];
  let total = 0;
  for (const file of files) {
    if (!file.isFile() || !/^[a-f0-9]{64}-(thumb|full)\.webp$/.test(file.name)) continue;
    try {
      const filePath = path.join(cacheDir, file.name);
      const info = await fs.stat(filePath);
      total += info.size;
      entries.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
    } catch (_) {}
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxBytes) break;
    try { await fs.unlink(entry.filePath); total -= entry.size; } catch (_) {}
  }
}

/**
 * Resolve and generate an immutable variant. The cache status is intentionally
 * returned with the bytes so the route can make a browser-visible diagnostic
 * header without exposing upstream URLs or cache paths.
 */
async function getPhoto({ provider, instructorId, variant, version, cacheDir = CACHE_DIR, fetchImpl = fetch, maxBytes = MAX_CACHE_BYTES }) {
  if (!VARIANTS[variant] || !validVersion(version)) return null;
  const negKey = `${cacheDir}|${version}|${variant}|${instructorId}`;
  const filePath = cachePath(cacheDir, version, variant);
  try {
    const cached = await readCached(filePath);
    if (cached) { stats.hits++; return { body: cached, cacheStatus: 'HIT' }; }
  } catch (_) {
    // A read error means persistence is unavailable. We can still try to
    // generate and return the image for this request below.
  }

  const negUntil = negative.get(negKey);
  if (negUntil && negUntil > Date.now()) return null;
  const key = `${cacheDir}|${version}|${variant}`;
  if (inFlight.has(key)) {
    stats.coalesced++;
    const result = await inFlight.get(key);
    return result && { ...result, cacheStatus: 'COALESCED' };
  }
  stats.misses++;
  const task = (async () => {
    try {
      let source;
      try { source = await withTimeout(Promise.resolve(provider.findInstructorPhoto(instructorId)), LOOKUP_TIMEOUT_MS); }
      catch (_) { stats.failures++; return TRANSIENT; }
      const url = source && (variant === 'thumb' ? (source.thumbUrl || source.imageUrl) : (source.imageUrl || source.thumbUrl));
      if (!url || versionFor(url) !== version) { negative.set(negKey, Date.now() + NEGATIVE_TTL_MS); return null; }

      // Check once more after source lookup: another request may have completed
      // before this task acquired the single-flight key.
      const cached = await readCached(filePath).catch(() => null);
      if (cached) { stats.hits++; return { body: cached, cacheStatus: 'HIT' }; }

      let input;
      try { input = await fetchBounded(url, fetchImpl); }
      catch (err) {
        stats.failures++;
        // Timeouts, network errors, 429/5xx: retryable. Anything else is permanent.
        if (err && (err.transient || err.name === 'AbortError' || err.name === 'TypeError' || err.code)) return TRANSIENT;
        negative.set(negKey, Date.now() + NEGATIVE_TTL_MS);
        return null;
      }
      const opts = VARIANTS[variant];
      const output = await sharp(input, { animated: false, limitInputPixels: 40_000_000 })
        .rotate()
        .resize(opts.width, opts.height, { fit: 'cover', position: 'attention', withoutEnlargement: true })
        .webp({ quality: opts.quality, effort: 4 })
        .toBuffer();

      try {
        await fs.mkdir(cacheDir, { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tempPath, output, { flag: 'wx' });
        await fs.rename(tempPath, filePath);
        await prune(cacheDir, maxBytes);
      } catch (_) {
        // The volume is a performance cache, not a correctness dependency.
        // Still return the just-generated image when it cannot be persisted.
      }
      stats.generated++;
      return { body: output, cacheStatus: 'MISS' };
    } catch (_) {
      stats.failures++;
      return null; // sharp/conversion failure: permanent for this source
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}

async function cacheUsage(cacheDir = CACHE_DIR) {
  try {
    const files = await fs.readdir(cacheDir, { withFileTypes: true });
    const sizes = await Promise.all(files.filter((f) => f.isFile() && f.name.endsWith('.webp')).map(async (f) => {
      try { return (await fs.stat(path.join(cacheDir, f.name))).size; } catch (_) { return 0; }
    }));
    return { bytes: sizes.reduce((a, b) => a + b, 0), files: sizes.length, maxBytes: MAX_CACHE_BYTES };
  } catch (_) {
    return { bytes: 0, files: 0, maxBytes: MAX_CACHE_BYTES };
  }
}

function getStats() { return { ...stats, inFlight: inFlight.size, maxCacheBytes: MAX_CACHE_BYTES }; }

module.exports = { LOOKUP_TIMEOUT_MS, CACHE_DIR, MAX_CACHE_BYTES, MAX_UPSTREAM_BYTES, UPSTREAM_TIMEOUT_MS, VARIANTS, versionFor, getPhoto, getStats, cacheUsage };
