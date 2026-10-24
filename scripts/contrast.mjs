// WCAG 2.x contrast. Usage: node scripts/contrast.mjs  (prints the token table used in DESIGN.md)
const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
export const over = (fg, a, bg) => fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
export const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const R = (a, b) => ratio(hex(a), hex(b));
const themes = {
  light: { bg: '#f4f2ec', surface: '#fbfaf7', text: '#1f1b16', t2: '#6b6358', t3: '#736a5d', accent: '#a8553a', accentFill: '#b5593d', onFill: '#ffffff', brandClay: '#c9785c', danger: '#b84343', success: '#047857', warning: '#9a6600', info: '#2f6bd1' },
  dark: { bg: '#161310', surface: '#201c18', text: '#f3ede4', t2: '#b9ae9f', t3: '#948a7c', accent: '#e09a7f', accentFill: '#c9785c', onFill: '#1a1411', brandClay: '#d68b6f', danger: '#f08a82', success: '#4cc794', warning: '#e5b03e', info: '#7fb0f0' },
};
const rows = [];
for (const [n, t] of Object.entries(themes)) {
  const add = (label, fg, bg) => rows.push(`${n.padEnd(5)} ${label.padEnd(34)} ${fg} on ${bg}  ${R(fg, bg).toFixed(2)}`);
  add('text / bg', t.text, t.bg); add('text / surface', t.text, t.surface);
  add('text-secondary / bg', t.t2, t.bg); add('text-secondary / surface', t.t2, t.surface);
  add('text-tertiary / bg', t.t3, t.bg); add('text-tertiary / surface', t.t3, t.surface);
  add('accent text / bg', t.accent, t.bg); add('accent text / surface', t.accent, t.surface);
  add('on-accent / accent-fill', t.onFill, t.accentFill);
  add('brand clay (decor) / bg', t.brandClay, t.bg); add('on-cta / cta-wait', n==='light'?'#ffffff':'#1a1411', n==='light'?'#8a4430':'#e4b7a2'); add('on-cta / cta-auto', n==='light'?'#ffffff':'#1a1411', n==='light'?'#6f3524':'#d9967a');
  for (const k of ['danger', 'success', 'warning', 'info']) add(`${k} text / surface`, t[k], t.surface);
}
console.log(rows.join('\n'));
// Glass: nav composite = rgba(surface,a) over bg-worst-case (page content behind: use bg and text-colour extremes)
const glass = (n, t, a) => {
  const s = hex(t.surface), worstDark = hex(n === 'light' ? '#1f1b16' : '#000000'), worstLight = hex(n === 'light' ? '#ffffff' : '#3a332c');
  for (const [lab, behind] of [['behind=darkest', worstDark], ['behind=lightest', worstLight]]) {
    const c = over(s, a, behind);
    console.log(`${n} glass a=${a} ${lab}: composite rgb(${c}) text-secondary ${ratio(hex(t.t2), c).toFixed(2)} text ${ratio(hex(t.text), c).toFixed(2)} accent ${ratio(hex(t.accent), c).toFixed(2)}`);
  }
};
glass('light', themes.light, 0.92); glass('dark', themes.dark, 0.82);
