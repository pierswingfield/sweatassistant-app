import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

// C7-2: client/public/sw.js hand-versioned its cache name ('psycle-cache-v2'),
// so a forgotten bump shipped stale JS forever — the SW's own `activate`
// handler only deletes caches that AREN'T its current name, and an unbumped
// name is trivially still current. Two independent `npm run build` runs
// produced byte-identical `dist/sw.js` cache names (verified 2026-09-27),
// confirming there was never any per-build differentiation at all.
//
// This plugin replaces the `__BUILD_STAMP__` placeholder in the BUILT
// `dist/sw.js` (never the source file in `public/`, which vite dev mode
// serves unprocessed and verbatim) with a token unique to this build, so
// every `npm run build` mints its own cache generation with no human step.
// `closeBundle` runs after Vite's own public-dir copy has already placed
// sw.js in `outDir`, which is why it patches the file in place there rather
// than trying to intercept it earlier in the pipeline.
function stampServiceWorker() {
  let root;
  let outDir;
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = config.build.outDir;
    },
    closeBundle() {
      const swPath = path.resolve(root, outDir, 'sw.js');
      if (!fs.existsSync(swPath)) {
        this.warn('[stamp-service-worker] dist/sw.js not found — nothing to stamp.');
        return;
      }
      const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const src = fs.readFileSync(swPath, 'utf8');
      if (!src.includes('__BUILD_STAMP__')) {
        this.warn('[stamp-service-worker] __BUILD_STAMP__ placeholder not found in dist/sw.js — cache name was NOT stamped.');
        return;
      }
      // The shell alone cannot boot an offline app: it needs Vite's hashed JS
      // and CSS too. Enumerate the built assets rather than hand-maintaining a
      // list in sw.js. Gym wordmarks are public build assets and belong in the
      // same atomic install, so the header and chips do not depend on a first
      // online render before they can appear.
      const staticUrls = [];
      for (const directory of ['assets', 'gyms']) {
        const absolute = path.resolve(root, outDir, directory);
        if (!fs.existsSync(absolute)) continue;
        for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue;
          const file = path.join(entry.parentPath || entry.path, entry.name);
          const relative = path.relative(path.resolve(root, outDir), file).split(path.sep).join('/');
          staticUrls.push(`/${relative}`);
        }
      }
      const precacheJson = JSON.stringify([...new Set(staticUrls)].sort());
      if (!src.includes('__PRECACHE_ASSETS_JSON__')) {
        this.warn('[stamp-service-worker] precache placeholder not found in dist/sw.js — built assets were NOT precached.');
      }
      fs.writeFileSync(
        swPath,
        src.split('__BUILD_STAMP__').join(stamp)
          .split('__PRECACHE_ASSETS_JSON__').join(precacheJson)
      );
    },
  };
}

// Local preview against a remote API (API_TARGET): the remote server may predate
// config fields the client now reads, so overlay them from the local
// gyms.config.js onto the catalogue. No effect when API_TARGET is unset.
function overlayLocalGymConfig() {
  return {
    name: 'overlay-local-gym-config',
    apply: 'serve',
    configureServer(server) {
      if (!process.env.API_TARGET) return;
      const { GYMS } = createRequire(import.meta.url)('../server/gyms.config.js');
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/gyms') return next();
        try {
          const r = await fetch(process.env.API_TARGET + '/api/gyms');
          const body = await r.json();
          body.gyms = (body.gyms || []).map((g) => ({ ...g, locationAliases: GYMS[g.id]?.locationAliases || g.locationAliases || {} }));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        } catch { next(); }
      });
    },
  };
}

export default defineConfig({
  plugins: [stampServiceWorker(), overlayLocalGymConfig()],
  test: {
    environment: 'jsdom',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        secure: true
      }
    }
  }
});
