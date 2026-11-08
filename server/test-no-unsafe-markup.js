// Security audit part 1: cheap source scan of client/src for three markup
// mistakes that are easy to reintroduce and easy to miss in review:
//   1. A private HTML escaper. There is ONE (client/src/escape-html.js, re-exported
//      by ui/cards.js); the old private copies disagreed (timetable's did not escape
//      quotes, so every escaped attribute there was still breakable).
//   2. A target=_blank link without rel="noopener noreferrer".
//   3. An href/src interpolated into markup without escapeHtml(...).
// Behavioural coverage (hostile names rendered through real components) lives in
// client/src/ui/xss-guard.test.js; this only pins the patterns above.
// Usage: node server/test-no-unsafe-markup.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'client', 'src');
const ESCAPER = 'escape-html.js';

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__fixtures__') yield* walk(full); } else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name)) yield full;
  }
}
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const offenders = [];
let scanned = 0;
for (const file of walk(SRC)) {
  const rel = path.relative(SRC, file).split(path.sep).join('/');
  const text = strip(fs.readFileSync(file, 'utf8'));
  scanned++;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    if (rel !== ESCAPER && /replace\(\s*\/&\/g\s*,\s*['"]&amp;['"]|\[&<>"'\]\/g/.test(line)) {
      offenders.push(`${at} private HTML escaper; import escapeHtml from escape-html.js / ui/cards.js`);
    }
    if (/target\s*=\s*["']_blank["']|\.target\s*=\s*['"]_blank['"]/.test(line)) {
      const near = lines.slice(i, i + 3).join(' ');
      if (!/noopener/.test(near) || !/noreferrer/.test(near)) offenders.push(`${at} target=_blank without rel="noopener noreferrer"`);
    }
    for (const m of line.matchAll(/\b(href|src)="\$\{([^}]*)\}/g)) {
      if (!/^\s*(escapeHtml|esc|escapeAttribute)\(/.test(m[2])) offenders.push(`${at} ${m[1]}="\${${m[2].trim()}}" is not escaped`);
    }
  });
}

assert.ok(scanned > 50, `scanned ${scanned} client files`);
assert.deepStrictEqual(offenders, [], `unsafe markup patterns:\n  ${offenders.join('\n  ')}`);
console.log(`PASS test-no-unsafe-markup (${scanned} files)`);
