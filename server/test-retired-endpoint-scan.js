// Retired-endpoint scan (C2 tests list): fails if any retired CodexFit v1 cart
// path appears anywhere in server/ source, so a future contributor can't
// accidentally reintroduce one once C2-1 has moved checkout to the v2 cart.
//
// STATUS (2026-09-26): this suite is PENDING C2-1. C2-1 ("Move in-app checkout
// to the v2 cart") has not landed yet — `server/server.js`'s legacy checkout
// routes (`/api/cart/add-bundle/:bundleId`, `/api/cart/checkout/init/:bundleId`,
// `/api/cart/checkout/confirm`) still call `/cart/add_bundle/...`,
// `/cart/get_payment_methods` and `/cart/ajaxCheckoutProcess` directly (see
// server.js ~L911-996), and `server/mock.js` mirrors those same retired paths
// so the dev-mode checkout flow has something to hit. Enforcing the scan today
// would make `npm test` red for a known, already-tracked gap (C2-1), which is
// exactly what Documentation/Workstreams/AGENT_PROTOCOL.md warns against: a
// suite that's "expected red" trains everyone to ignore red suites.
//
// So: the scan logic below is real and runs every time, but only ENFORCES
// (exits non-zero on a hit) when RETIRED_SCAN_ENFORCE=1 is set — `run-tests.js`
// discovers this file and runs it with default env, so `npm test` stays green
// while still printing exactly what would fail and why. Confirmed today: with
// enforcement on, this correctly fails on 2 files / 3 patterns (see below).
//
// TO ENABLE (do this as part of C2-1, in the same change that removes the
// legacy routes and switches mock.js to the v2 envelope):
//   1. Delete the `RETIRED_SCAN_ENFORCE` gate below (the `if` and its early
//      exit) so this always enforces.
//   2. Remove `server/mock.js` from the exclusion list, since a fixed mock.js
//      should no longer contain the retired paths either.
//   3. Run `RETIRED_SCAN_ENFORCE=1 node server/test-retired-endpoint-scan.js`
//      once by hand first to confirm it's clean, then let run-tests.js pick it
//      up normally.

const fs = require('fs');
const path = require('path');

const RETIRED_PATTERNS = ['/cart/add_bundle', 'get_payment_methods', 'ajaxCheckoutProcess'];

// mock.js deliberately mirrors the retired v1 endpoints so dev-mode checkout
// (server.js's legacy routes) has something to call locally, pending C2-1.
// Once C2-1 lands, mock.js moves to the v2 envelope too and this exclusion
// should be deleted (step 2 above).
const EXCLUDED_FILES = new Set(['mock.js', 'test-retired-endpoint-scan.js']);

function scanDir(dir) {
  const hits = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      hits.push(...scanDir(full));
      continue;
    }
    if (!entry.name.endsWith('.js') || EXCLUDED_FILES.has(entry.name)) continue;
    const contents = fs.readFileSync(full, 'utf8');
    for (const pattern of RETIRED_PATTERNS) {
      if (contents.includes(pattern)) hits.push(`${path.relative(process.cwd(), full)}: "${pattern}"`);
    }
  }
  return hits;
}

const hits = scanDir(__dirname);

if (process.env.RETIRED_SCAN_ENFORCE === '1') {
  if (hits.length) {
    console.error('✗ Retired CodexFit v1 cart path(s) found in server/ source:');
    for (const h of hits) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log('✓ No retired CodexFit v1 cart paths found in server/ source.');
  process.exit(0);
}

// Default path (what `npm test` / run-tests.js actually runs): report, don't
// fail. See the STATUS note above — this is a known, tracked gap (C2-1), not
// an unnoticed regression.
console.log(`PENDING C2-1: retired v1 cart reference(s) still present (expected until C2-1 lands):`);
for (const h of hits) console.log(`  ${h}`);
if (hits.length === 0) {
  console.log('  (none found — if C2-1 has landed, flip RETIRED_SCAN_ENFORCE on permanently; see header.)');
}
console.log('PENDING C2-1 — not enforcing yet. Run with RETIRED_SCAN_ENFORCE=1 to see this fail for real.');
process.exit(0);
