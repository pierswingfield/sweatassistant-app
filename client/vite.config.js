import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

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
      fs.writeFileSync(swPath, src.split('__BUILD_STAMP__').join(stamp));
    },
  };
}

export default defineConfig({
  plugins: [stampServiceWorker()],
  test: {
    environment: 'jsdom',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
});
