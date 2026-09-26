// Retired-endpoint scan (C2 tests list): fails if any retired CodexFit v1 cart
// path appears anywhere in server/ source, so a future contributor can't
// accidentally reintroduce one now that C2-1 has moved checkout to the v2 cart.
//
// STATUS (2026-09-26): ENFORCING. C2-1 moved the in-app checkout routes
// (server/routes-normalized.js's `/cart/checkout/init/:bundleId` and
// `/cart/checkout/confirm`) onto the v2 cart lifecycle
// (server/providers/codexfit-cart.js), and server/mock.js now mirrors the v2
// envelope instead of the v1 one. Confirmed clean with enforcement on before
// flipping this on for real (see C2-psycle-api-v2.md's C2-1 entry).

const fs = require('fs');
const path = require('path');

const RETIRED_PATTERNS = ['/cart/add_bundle', 'get_payment_methods', 'ajaxCheckoutProcess'];

// test-codexfit-v2-cart.js deliberately references these pattern strings as
// literals (asserting codexfit-cart.js does NOT contain them) — that's a
// test asserting absence, not a reintroduction, so it's excluded the same way
// this scan file excludes itself.
const EXCLUDED_FILES = new Set(['test-retired-endpoint-scan.js', 'test-codexfit-v2-cart.js']);

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

if (hits.length) {
  console.error('✗ Retired CodexFit v1 cart path(s) found in server/ source:');
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log('✓ No retired CodexFit v1 cart paths found in server/ source.');
process.exit(0);
