// Shared card primitives — inline SVG icon set + class-discipline tagging.
// Used by the Auto-Book tab (autobook.js) and My Bookings (bookings.js) so the
// card visual language (glyphs, discipline pills) stays identical everywhere.

// ── Inline SVG icon set (themeable via currentColor) ─────────────────
export const SVG_PATHS = {
  clock: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.5V8l2.5 1.5"/>',
  edit: '<path d="M11 2.5 13.5 5 6 12.5 3 13l.5-3L11 2.5Z"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
  checkCircle: '<circle cx="8" cy="8" r="6.25"/><path d="M5.3 8.2 7 9.9l3.7-3.9"/>',
  error: '<circle cx="8" cy="8" r="6.25"/><path d="M8 5v3.5M8 11h.01"/>',
  bang: '<path d="M8 4v5M8 11.5h.01"/>',
  history: '<path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v2.2h2.2M8 5.5V8l2 1.2"/>',
  chevron: '<path d="M4 6l4 4 4-4"/>',
  pause: '<path d="M6 4v8M10 4v8"/>',
  play: '<path d="M5.5 4l6 4-6 4z"/>',
  heart: '<path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z"/>',
  bolt: '<path d="M8.5 1.5 3.5 9h3.5l-1 5.5L13 6.5H9z"/>',
  warning: '<path d="M8 2 14.5 13.5h-13L8 2Z"/><path d="M8 6.5v3M8 11.8h.01"/>',
  // discipline glyphs
  ride: '<circle cx="4.3" cy="11" r="2.5"/><circle cx="11.7" cy="11" r="2.5"/><path d="M4.3 11 7 5.5h2.5l2.2 5.5M7 5.5 6.2 4H4.5"/>',
  barre: '<path d="M2 8h12M3.5 6v4M12.5 6v4"/>',
  strength: '<path d="M2.5 6v4M4.2 5v6M11.8 5v6M13.5 6v4M4.2 8h7.6"/>',
  infrared: '<path d="M8 2c1.8 2.2 3 3.7 3 6a3 3 0 1 1-6 0c0-1 .4-1.8 1-2.5.2 1 .8 1.5 1.3 1.5-.5-1.7.7-4 .7-5Z"/>',
  reformer: '<path d="M2 5h12M2 11h12M5 5v6M11 5v6"/>',
  yoga: '<circle cx="8" cy="3.7" r="1.8"/><path d="M8 6.5v3M3.5 13c1.2-2.5 7.8-2.5 9 0"/>',
  other: '<circle cx="8" cy="8" r="2.6"/>',
};
const FILLED_ICONS = new Set(['play', 'heart', 'bolt']);

export function icon(name, size = 14) {
  const inner = SVG_PATHS[name] || SVG_PATHS.other;
  const filled = FILLED_ICONS.has(name);
  return `<svg class="ab-ico" width="${size}" height="${size}" viewBox="0 0 16 16" `
    + `fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" `
    + `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Derive a class discipline (token + label + glyph) from the group/class name.
export function getDiscipline(name = '') {
  const s = String(name).toLowerCase();
  const D = (key, label) => ({ key, label, icon: SVG_PATHS[key] ? key : 'other' });
  if (/ride|cycle|spin/.test(s)) return D('ride', 'Ride');
  if (/barre/.test(s)) return D('barre', 'Barre');
  if (/reformer|pilates/.test(s)) return D('reformer', 'Reformer');
  if (/infrared|hot|sweat/.test(s)) return D('infrared', 'Infrared');
  if (/yoga|flow|mind|meditat/.test(s)) return D('yoga', 'Yoga');
  if (/strength|tone|sculpt|hiit|abs|arms|signature/.test(s)) return D('strength', 'Strength');
  const label = name ? String(name).replace(/\b\w/g, c => c.toUpperCase()) : 'Class';
  return { key: 'other', label, icon: 'other' };
}

// Render a discipline tag chip (coloured pastel pill with glyph).
export function disciplineTag(name) {
  const d = getDiscipline(name);
  return `<span class="ab-disc-tag" data-disc="${d.key}">${icon(d.icon, 11)}${d.label}</span>`;
}

// Strip the "Psycle " prefix from a location name (matches the timetable filters).
export function trimLocation(name = '') {
  return String(name).replace(/^Psycle\s*/i, '');
}
