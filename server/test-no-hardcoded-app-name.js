// The product name is configuration, not code. Fails when a hardcoded
// 'Sweat Assistant' (or bare 'Sweat') appears in app source outside
// server/config.js, the one place the default lives. Comments are ignored; docs and
// tests are out of scope (this test and the propagation test name it on purpose).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ALLOWED = new Set(['server/config.js']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'public', 'fixtures', '.git', 'scripts']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIR.has(e.name) && !(dir === path.join(ROOT, 'client') && e.name === 'public')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

// Remove comments per file type so prose in comments cannot trip the scan.
function stripComments(file, text) {
  if (/\.(js|mjs|cjs|css)$/.test(file)) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  }
  if (/\.html$/.test(file)) return text.replace(/<!--[\s\S]*?-->/g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  return text;
}

const offenders = [];
let scanned = 0;
for (const base of ['client', 'server']) {
  for (const file of walk(path.join(ROOT, base))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    if (!/\.(js|mjs|cjs|css|html|json|webmanifest)$/.test(rel)) continue;
    if (/(^|\/)(test-[^/]*\.js|[^/]*\.test\.js)$/.test(rel)) continue;
    if (/(^|\/)(package-lock|package)\.json$/.test(rel)) continue;
    scanned++;
    const code = stripComments(file, fs.readFileSync(file, 'utf8'));
    code.split('\n').forEach((line, i) => {
      if (/Sweat Assistant|\bSweat\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
}
assert.ok(scanned > 50, `scanned a plausible number of files (${scanned})`);
assert.deepStrictEqual(offenders, [], `hardcoded product name outside server/config.js:\n${offenders.join('\n')}`);
console.log(`PASS no hardcoded product name in ${scanned} app files.`);
