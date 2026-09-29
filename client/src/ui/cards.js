// Shared card primitives — inline SVG icon set + class-discipline tagging.
// Used by the Auto-Book tab (autobook.js) and My Bookings (bookings.js) so the
// card visual language (glyphs, discipline pills) stays identical everywhere.

import { cleanClassNameWith } from '../class-name.js';
import { spriteRefFor } from '../gym-logo-sprite.js';
import { getGymPresentation, getGymShortName, getDisplayAlias } from '../gym-context.js';

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
  filter: '<path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7"/><circle cx="10.5" cy="4.5" r="1.6"/><circle cx="5.5" cy="11.5" r="1.6"/>',
  user: '<circle cx="8" cy="5.3" r="2.4"/><path d="M3 13.5c.8-2.6 2.8-3.8 5-3.8s4.2 1.2 5 3.8"/>',
  heart: '<path d="M8 13.5S2.5 10 2.5 6.2A2.7 2.7 0 0 1 8 5a2.7 2.7 0 0 1 5.5 1.2C13.5 10 8 13.5 8 13.5Z"/>',
  bolt: '<path d="M8.5 1.5 3.5 9h3.5l-1 5.5L13 6.5H9z"/>',
  warning: '<path d="M8 2 14.5 13.5h-13L8 2Z"/><path d="M8 6.5v3M8 11.8h.01"/>',
  star: '<path d="M8 1.5l2.12 4.3 4.75.69-3.44 3.35.81 4.73L8 12.33l-4.24 2.24.81-4.73L1.13 6.49l4.75-.69L8 1.5z"/>',
  // Row overflow-menu glyphs.
  cog: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5"/>',
  grid: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  // Settings menu glyphs (U1-10). Same 16px grid and 1.6 stroke as the rest.
  sliders: '<path d="M2.5 4.5H6M10.5 4.5h3M2.5 11.5h1.5M8 11.5h5.5"/><circle cx="8.25" cy="4.5" r="1.75"/><circle cx="6" cy="11.5" r="1.75"/>',
  bell: '<path d="M4 11V7.2a4 4 0 0 1 8 0V11l1.2 1.5H2.8L4 11Z"/><path d="M6.6 14a1.5 1.5 0 0 0 2.8 0"/>',
  user: '<circle cx="8" cy="5.5" r="2.7"/><path d="M2.8 13.8c.6-2.6 2.5-3.9 5.2-3.9s4.6 1.3 5.2 3.9"/>',
  link: '<path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 0 0-3.7-3.7l-.6.6"/><path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 0 0 3.7 3.7l.6-.6"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.3v3.7M8 5h.01"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.8v2.6h-2.6"/>',
  power: '<path d="M8 2v5.2"/><path d="M4.9 4.4a5 5 0 1 0 6.2 0"/>',
  bug: '<path d="M5.5 5.5a2.5 2.5 0 0 1 5 0v3a2.5 2.5 0 0 1-5 0Z"/><path d="M3 6.5h2.5M10.5 6.5H13M3 10h2.5M10.5 10H13M6 3.5l1-1M10 3.5l-1-1"/>',
  // discipline glyphs
  ride: '<circle cx="4.3" cy="11" r="2.5"/><circle cx="11.7" cy="11" r="2.5"/><path d="M4.3 11 7 5.5h2.5l2.2 5.5M7 5.5 6.2 4H4.5"/>',
  barre: '<path d="M2 8h12M3.5 6v4M12.5 6v4"/>',
  strength: '<path d="M2.5 6v4M4.2 5v6M11.8 5v6M13.5 6v4M4.2 8h7.6"/>',
  infrared: '<path d="M8 2c1.8 2.2 3 3.7 3 6a3 3 0 1 1-6 0c0-1 .4-1.8 1-2.5.2 1 .8 1.5 1.3 1.5-.5-1.7.7-4 .7-5Z"/>',
  reformer: '<path d="M2 5h12M2 11h12M5 5v6M11 5v6"/>',
  yoga: '<circle cx="8" cy="3.7" r="1.8"/><path d="M8 6.5v3M3.5 13c1.2-2.5 7.8-2.5 9 0"/>',
  // A boxing glove: cuff plus fist, at the same 16px weight as the others.
  boxing: '<path d="M5 6.5a3 3 0 0 1 3-3h1.5a3 3 0 0 1 3 3V9a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z"/><path d="M5 7.5H3.8A1.3 1.3 0 0 0 2.5 8.8v.9A1.3 1.3 0 0 0 3.8 11H5"/><path d="M5.5 12.5h6.5v1.2a.8.8 0 0 1-.8.8H6.3a.8.8 0 0 1-.8-.8Z"/>',
  recovery: '<path d="M2.5 11h11a2.5 2.5 0 0 1 2.5 2.5v.5H0v-.5A2.5 2.5 0 0 1 2.5 11Z"/><path d="M2.5 14v1.5M13.5 14v1.5"/><path d="M5 3.5c0 1.2-1 1.6-1 2.5s1 1.2 1 2.5M8 2.5c0 1.2-1 1.6-1 2.5s1 1.2 1 2.5M11 3.5c0 1.2-1 1.6-1 2.5s1 1.2 1 2.5"/>',
  conditioning: '<path d="M2 8h2.5l1.8-4 2.4 8 1.8-4H14"/>',
  other: '<circle cx="8" cy="8" r="2.6"/>',
};
const FILLED_ICONS = new Set(['play', 'heart', 'bolt', 'star']);

export function icon(name, size = 14) {
  const inner = SVG_PATHS[name] || SVG_PATHS.other;
  const filled = FILLED_ICONS.has(name);
  return `<svg class="ab-ico" width="${size}" height="${size}" viewBox="0 0 16 16" `
    + `fill="${filled ? 'currentColor' : 'none'}" stroke="${filled ? 'none' : 'currentColor'}" `
    + `stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

// Derive a class discipline (token + label + glyph) from the normalized
// `discipline` field, falling back to keyword matching on the name.
//
// The keyword list is a HEURISTIC over vocabulary, not a gym's class catalogue:
// every term below ("ride", "barre", "boxing"…) is an activity name that any gym
// might use. It exists because the token/glyph set is finite and a discipline
// string has to map onto one of them; an unrecognised discipline lands on
// `other`, which renders as a neutral chip carrying the gym's own label rather
// than as a missing style.
//
// Both adapters populate `NormalizedEvent.discipline` (codexfit from the event
// type's group, marianatek from the classroom), so prefer that over re-deriving
// it from a display name.
export function getDiscipline(name = '') {
  const raw = String(name || '').trim();
  const s = raw.toLowerCase();
  const D = (key, label) => ({ key, label, icon: SVG_PATHS[key] ? key : 'other' });
  if (/ride|cycle|spin/.test(s)) return D('ride', 'Ride');
  if (/barre/.test(s)) return D('barre', 'Barre');
  if (/reformer|pilates|lagree/.test(s)) return D('reformer', 'Reformer');
  if (/recovery|sauna|bath|cold|ice|cryo/.test(s)) return D('recovery', 'Recovery');
  if (/infrared|hot|sweat/.test(s)) return D('infrared', 'Infrared');
  if (/yoga|flow|mind|meditat/.test(s)) return D('yoga', 'Yoga');
  if (/box|punch|bag|spar/.test(s)) return D('boxing', 'Boxing');
  // "Train" is JAB's own first-class discipline (its `discipline` field is
  // literally "TRAIN"), not a synonym for Psycle's "Conditioning" keyword
  // bucket below — regression found 2026-09-02: mapping it into that bucket
  // gave it an icon but relabelled every JAB Train booking as "Conditioning".
  // Reuses the conditioning icon (both read as circuit/functional training)
  // but keeps its own label. "Throwdown" is JAB's monthly themed TRAIN-room
  // event ("THURSDAY THROWDOWN") — its class_type.name carries no discipline
  // word at all, so without this it fell to its own one-off bucket instead of
  // grouping with the room it's actually held in.
  if (/\btrain|throwdown/.test(s)) return { key: 'conditioning', label: 'Train', icon: 'conditioning' };
  if (/condition|circuit|metcon|cardio/.test(s)) return D('conditioning', 'Conditioning');
  if (/strength|tone|sculpt|hiit|abs|arms|signature|\blift\b/.test(s)) return D('strength', 'Strength');
  // Checked after the discipline-specific buckets above, not before: a class
  // type that already names a real discipline (e.g. a future "Boxing PT")
  // should keep that label, and these two only catch what's left —
  // JAB's "Small Group PT" (a format, not a discipline) and "Workshop"
  // one-offs, both real `class_type.name` values with no discipline word in
  // them at all (confirmed 2026-09-15 against 855 live JAB classes).
  if (/\bworkshop\b/.test(s)) return D('workshop', 'Workshop');
  if (/\bpt\b|personal training/.test(s)) return D('pt', 'PT');
  // Unrecognised: keep the gym's own wording rather than inventing a label.
  const label = raw ? raw.replace(/\b\w/g, c => c.toUpperCase()) : 'Class';
  return { key: 'other', label, icon: 'other' };
}

// Render a discipline tag chip (coloured pastel pill with glyph).
export function disciplineTag(name) {
  const d = getDiscipline(name);
  return `<span class="ab-disc-tag" data-disc="${d.key}">${icon(d.icon, 11)}${d.label}</span>`;
}

// Make every `.ab-disc-tag` within `container` the same width — the widest
// chip actually present, not a static CSS guess. `.ab-disc-tag`'s base width
// in styles.css is a fallback for before this runs (or if a view never calls
// it); this is what makes chips align across a whole timetable/card list,
// where labels range from "Ride" to "Conditioning". Call after any render
// that inserts new discipline chips — re-measures from scratch each time
// rather than tracking a running max, since a re-filtered view can lose its
// widest label.
/**
 * U4-9: decide, per rendered view, whether discipline pills wear the OWNING GYM's
 * brand colour. True only when the view currently shows classes from MORE THAN ONE
 * gym; a single-gym view keeps the per-concept colours (Ride, Barre, ...). The
 * answer is written as `data-multi-gym` on the container, and styles.css recolours
 * `.ab-disc-tag` from the `--gym-*` vars its row/card already inherits via `[data-gym]`.
 * One lookup for one fact: every renderer reaches it through equalizeDiscTagWidths()
 * (called after each render/re-filter), so nothing re-derives it.
 * @returns {boolean} whether the container is multi-gym
 */
export function syncGymBrandedTags(container) {
  if (!container || container === document || !container.querySelectorAll) return false;
  // The rule is per PAGE, not per list: Active Bookings and Waitlists render into separate
  // containers, so evaluate across the whole tab panel that holds this container and mark
  // the panel. Every list re-runs this after it renders, so whichever lands last decides
  // with the full picture. Containers outside a tab panel (e.g. the overlap modal) are their own scope.
  const scope = container.closest?.('.psycle-tab-content') || container;
  const gyms = new Set();
  scope.querySelectorAll('.ab-disc-tag').forEach((tag) => {
    const id = tag.closest('[data-gym]')?.getAttribute('data-gym');
    if (id) gyms.add(id);
  });
  const multi = gyms.size > 1;
  scope.toggleAttribute('data-multi-gym', multi);
  if (scope !== container) container.removeAttribute('data-multi-gym');
  return multi;
}

export function equalizeDiscTagWidths(container = document) {
  syncGymBrandedTags(container); // U4-9 (this is the one hook every view calls after rendering)
  // NO-OP by design (2026-09-15).
  //
  // This used to force every discipline chip to the widest label's width so the
  // class names beside them lined up. The cost was that one long label
  // ("CONDITIONING") sized every chip in the view, and short ones like RIDE sat
  // in a chip with a third of it empty — the chip looked broken and the width it
  // took came out of the class NAME, which is the thing people read.
  //
  // Chips are now content-sized. Column alignment is preserved a level up
  // instead: `.psycle-table td.col-class` has a fixed percentage width, so the
  // COLUMN does not move even though the chip inside it varies.
  //
  // Kept as an exported no-op rather than deleted because several modules call
  // it after rendering; removing it means touching all of them for no gain.
  void container;
}

export function trimLocation(name = '', gymName = '') {
  const n = String(name || '');
  if (!gymName) return n;
  // First word of the gym name — "Psycle London" should also trim "Psycle …".
  const first = String(gymName).trim().split(/\s+/)[0];
  if (!first) return n;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return n.replace(new RegExp(`^${esc}\\s*`, 'i'), '') || n;
}

// U1-11: one rule for dropping the discipline prefix, not two. This used to be a
// second regex here that disagreed with cleanClassName (it matched only the raw
// discipline string, so JAB's "TRAIN - Upper (Focus)" survived in My Bookings).
// Kept as an alias so existing imports keep working.
export function stripClassNamePrefix(name = '', group = '') {
  return cleanClassName(name, group) || String(name || '');
}

// Display-only studio alias, from the OWNING gym's presentation contract
// (gyms.config.js displayAliases.studios). Never touches the raw name used for
// floor-plan lookups/spot-map config. No gym ids live here.
export function displayStudioName(gymId, name = '') {
  return getDisplayAlias(gymId, 'studios', name);
}

// Returns "bike" when the class group is Ride, otherwise "spot".
// Use for user-facing copy in single-class contexts (booking modals, edit modals,
// auto-upgrade cards, auto-book queue cards). Do NOT use for studio-wide spot-map
// editor text — the shared map serves all class types at a studio.
// Capitalise the first letter when the word starts a sentence/label/title.
export function seatNoun(groupName = '') {
  // Discipline-driven, not gym-driven: any gym running a cycle class has bikes.
  return /^ride$|cycle|spin/i.test(String(groupName)) ? 'bike' : 'spot';
}

export function sparklesIcon(size = 14, color = 'currentColor') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="${color}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:inline-block;vertical-align:middle;">
<g data-name="Layer 2" id="Layer_2">
<path d="M18,11a1,1,0,0,1-1,1,5,5,0,0,0-5,5,1,1,0,0,1-2,0,5,5,0,0,0-5-5,1,1,0,0,1,0-2,5,5,0,0,0,5-5,1,1,0,0,1,2,0,5,5,0,0,0,5,5A1,1,0,0,1,18,11Z"/>
<path d="M19,24a1,1,0,0,1-1,1,2,2,0,0,0-2,2,1,1,0,0,1-2,0,2,2,0,0,0-2-2,1,1,0,0,1,0-2,2,2,0,0,0,2-2,1,1,0,0,1,2,0,2,2,0,0,0,2,2A1,1,0,0,1,19,24Z"/>
<path d="M28,17a1,1,0,0,1-1,1,4,4,0,0,0-4,4,1,1,0,0,1-2,0,4,4,0,0,0-4-4,1,1,0,0,1,0-2,4,4,0,0,0,4-4,1,1,0,0,1,2,0,4,4,0,0,0,4,4A1,1,0,0,1,28,17Z"/>
</g>
</svg>`;
}

export function trendingUpIcon(size = 14, color = 'currentColor', strokeWidth = 2) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" class="feather feather-trending-up" aria-hidden="true" style="display:inline-block;vertical-align:middle;">
<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
<polyline points="17 6 23 6 23 12"></polyline>
</svg>`;
}

export function pulseIcon(size = 14) {
  return `<svg class="psycle-pulse-icon" width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-right:4px;">
    <circle class="radar" cx="12" cy="12" r="2" />
    <circle class="core" cx="12" cy="12" r="2" />
  </svg>`;
}

// ── Gym Branding & Leftmost Card Rail ─────────────────────────────────────────
/**
 * A gym's real brand assets — wordmark and the background it is designed to sit
 * on. Both gyms supply a WHITE wordmark, so each is paired with its own dark
 * brand colour rather than dropped onto the app's surface where a white logo is
 * invisible.
 *
 * `brandBg` is the gym's own identity colour and is used ONLY behind that gym's
 * logo. It is deliberately separate from the `--gym-*` tokens in styles.css,
 * which tint rows and rails and have to stay legible against the page in both
 * themes — a near-black (#212121) works as a logo plate and would be unreadable
 * as a row tint.
 *
 * JAB's mark ships as inline SVG (it scales and inherits nothing, so it stays
 * crisp); Psycle's is an AVIF served from /gyms/.
 */
/**
 * ONE place that turns a wordmark `src` into markup. Inline <svg><use> when the .svg is in the sprite
 * (paints synchronously, nothing to decode or fetch, survives any re-render), else the <img> fallback.
 */
export function wordmarkElement(cls, src, styleAttr = '') {
  const ref = spriteRefFor(src);
  if (ref) return `<svg class="${cls} gym-logo-inline" viewBox="${ref.viewBox}" aria-hidden="true" focusable="false"${styleAttr}><use href="#${ref.id}"></use></svg>`;
  return `<img class="${cls}" src="${src}" alt="" aria-hidden="true" decoding="sync"${styleAttr}>`;
}

export function gymBrand(gymId) {
  const rawId = String(gymId || '');
  const p = getGymPresentation(rawId);
  // Optional data-driven optical scale for a gym's wordmark inside its (unchanged) chip: presentation.wordmark.scale.
  const scale = Number(p?.wordmark?.scale);
  const sty = Number.isFinite(scale) && scale > 0 && scale !== 1 ? ` style="--logo-scale:${scale}"` : '';
  const img = (cls, w) => wordmarkElement(cls, w.src, sty);
  if (!p) {
    // Neutral fallback: unknown gym, or the catalogue has not loaded yet. A text
    // wordmark on a neutral plate, never another gym's assets.
    const label = getGymShortName(rawId) || rawId || 'Gym';
    return {
      id: 'neutral',
      name: label,
      shortName: label,
      brandBg: '#3f3f46',
      // Blank placeholder on the neutral plate: the catalogue has not arrived, and printing the raw
      // gym id here is what flashed as text while logos loaded.
      markHtml: `<span class="fr-mark-text" aria-hidden="true"></span>`,
      logoSvg: `<span class="ab-gym-logo-text" aria-hidden="true"></span>`,
    };
  }
  const w = p.wordmark || {};
  const full = w.full, compact = w.compact;
  let logoSvg;
  if (!full && !compact) {
    logoSvg = `<span class="ab-gym-logo-text" aria-hidden="true">${escapeHtml(w.text)}</span>`;
  } else if (full && compact && full.src !== compact.src) {
    // Both always in the DOM; CSS picks by viewport (no flash on resize). See
    // the .is-full/.is-half rules in styles.css.
    logoSvg = wordmarkElement('ab-gym-logo-img is-full', full.src, sty)
      + wordmarkElement('ab-gym-logo-img is-half', compact.src, sty);
  } else {
    logoSvg = img('ab-gym-logo-svg', full || compact);
  }
  return {
    id: rawId,
    name: p.shortName,
    shortName: p.shortName,
    brandBg: p.plate,
    markHtml: w.mark ? img('fr-mark-img', w.mark) : `<span class="fr-mark-text" aria-hidden="true">${escapeHtml(String(p.shortName).charAt(0))}</span>`,
    logoSvg,
  };
}

export function gymChip(gymId) {
  const brand = gymBrand(gymId);
  // The gym's actual wordmark on its actual brand colour. A logo alone is still
  // not the only signal — the row tint and, in cards, the rail carry it too —
  // but the wordmark is what people recognise a gym by, and a generic glyph
  // plus capitals was a stand-in for not having the real asset.
  //
  // `title` and the visually-hidden name keep the gym readable to screen
  // readers and to anyone who doesn't know the marks yet, since the image
  // itself is aria-hidden.
  return `<span class="psycle-gym-chip psycle-gym-chip-${brand.id}" title="${brand.name}" style="background:${brand.brandBg};border:1px solid ${brand.brandBg}">`
    + `<span class="psycle-gym-chip-logo">${brand.logoSvg}</span>`
    + `<span class="u-visually-hidden">${brand.name}</span>`
    + `</span>`;
}

/**
 * A SQUARE (1:1) gym mark: the gym's own wordmark on the gym's own brand plate.
 *
 * `gymChip` is the wide table plate and `renderGymRail` the tall card rail; this
 * is the third shape, for places that want a small icon-sized identifier (the
 * per-gym Settings menu entries). Same assets and same brand colours as the other
 * two — the plate colour comes from `.psycle-gym-mark-<id>` in styles.css, which
 * mirrors `.psycle-gym-chip-<id>` — so the three can never disagree about what a
 * gym looks like. Decorative: the gym's name is always rendered beside it.
 */
export function gymSquareChip(gymId) {
  const brand = gymBrand(gymId);
  return `<span class="psycle-gym-mark psycle-gym-mark-${brand.id}" style="background:${brand.brandBg}" aria-hidden="true">${brand.logoSvg}</span>`;
}

export function renderGymRail(gymId) {
  const brand = gymBrand(gymId);
  return `
    <div class="ab-card-gym-rail" data-gym="${brand.id}" title="${brand.name}" style="background:${brand.brandBg};border-right-color:${brand.brandBg}">
      <div class="ab-gym-logo">${brand.logoSvg}</div>
      <span class="u-visually-hidden">${brand.name}</span>
    </div>
  `;
}


/**
 * Shared HTML escaper. Four modules each had a private copy of this
 * (timetable, settings, credits, gym-settings-section); new call sites should
 * import this one rather than adding a fifth.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/**
 * Compact seat labels for a floor plan.
 *
 * Providers label seats with the noun repeated on every one — "Bike 11",
 * "Bike 12", "Reformer 3". Inside a floor plan that noun is redundant (every
 * square in a ride studio is a bike) and it is what forces the label to wrap to
 * two lines in a ~30px square, where it then collides with the preference-order
 * badge. The full label stays in the `title` and in the caption underneath.
 *
 * Only strips a first word that EVERY label shares, so a studio mixing
 * "Bike 11" with "Bench 2" keeps both in full rather than silently losing the
 * distinction.
 *
 * @param {Array<{id:*, label?:string}>} slots
 * @returns {Map<string,string>} slot id (as string) → short label
 */
export function shortSlotLabels(slots = []) {
  const out = new Map();
  const labels = slots.map(s => String(s.label ?? s.id ?? ''));
  const firstWords = labels.map(l => (l.trim().split(/\s+/)[0] || ''));
  const shared = firstWords.length > 1
    && firstWords.every(w => w && /^[A-Za-z]+$/.test(w) && w === firstWords[0]);
  slots.forEach((slot, i) => {
    const full = labels[i];
    const rest = shared ? full.trim().slice(firstWords[0].length).trim() : '';
    out.set(String(slot.id), shared && rest ? rest : full);
  });
  return out;
}

export function cleanClassName(name = '', discipline = '') {
  const disc = String(discipline || '').trim();
  return cleanClassNameWith(name, discipline, disc ? getDiscipline(disc).label : '');
}

/**
 * Desktop card row 2 = tag, class, "·", INSTRUCTOR (row 3 = location). The instructor also
 * stays in the right-hand figure for mobile; CSS shows exactly one of the two per breakpoint
 * (`.ab-card-instructor-inline` >= 768px, the figure's name below). One helper, used by every
 * card that shares the line1/line2/figure markup.
 */
export function instructorInlineHtml(name) {
  return name ? `<span class="ab-meta-dot ab-dot-instr">·</span><span class="ab-card-instructor-inline">${name}</span>` : '';
}

// Hide the "·" separator when the location wraps onto its own line. Wrapping
// is only knowable from layout, so pure CSS can't do it; one ResizeObserver per
// container, disconnected on every re-render.
const locationWrapObservers = new WeakMap();
export function updateLocationDots(root) {
  root.querySelectorAll('.ab-card-line2').forEach(line => {
    const loc = line.querySelector('.ab-card-location');
    const dot = line.querySelector('.ab-meta-dot:not(.ab-dot-instr)');
    const cls = line.querySelector('.ab-card-titlegroup') || line.querySelector('.ab-card-class');
    if (!loc || !dot || !cls) return;
    dot.classList.toggle('is-wrapped', loc.offsetTop > cls.offsetTop + 2);
  });
}
export function observeLocationWrap(container) {
  const prev = locationWrapObservers.get(container);
  if (prev) prev.disconnect();
  updateLocationDots(container);
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => updateLocationDots(container));
  locationWrapObservers.set(container, ro);
  container.querySelectorAll('.ab-card-line2').forEach(l => ro.observe(l));
}


// Action rail toggle (shared by My Bookings, Waitlists, Auto-Book, Auto-Upgrade).
// The rail is collapsed by default; a "more" button at the end of the footer
// slides it in. Open state is remembered per card across re-renders.
const openRails = new Set();
let railSeq = 0;
export function wireRailToggle(container) {
  container.querySelectorAll('.ab-card').forEach(card => {
    const rail = card.querySelector(':scope > .ab-card-rail');
    const footer = card.querySelector('.ab-card-footer');
    if (!rail || !footer || footer.querySelector('.ab-rail-toggle')) return;
    const last = rail.querySelector('.ab-rail-btn:last-child');
    const key = (last ? last.className : '') + '|' + (card.dataset.eventId || (last && last.dataset.id) || '') + '|' + (card.dataset.gym || '');
    rail.id = rail.id || `ab-rail-${++railSeq}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ab-rail-toggle';
    btn.setAttribute('aria-controls', rail.id);
    btn.innerHTML = '<svg class="ab-ico ab-rail-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="10 3 5 8 10 13"/></svg><span>Edit</span>';
    const apply = (open) => {
      card.classList.toggle('is-rail-open', open);
      btn.setAttribute('aria-expanded', String(open));
      btn.setAttribute('aria-label', open ? 'Hide actions' : 'Show actions (edit or cancel)');
      if (open) rail.removeAttribute('inert'); else rail.setAttribute('inert', '');
    };
    btn.addEventListener('click', () => {
      const open = !card.classList.contains('is-rail-open');
      if (open) openRails.add(key); else openRails.delete(key);
      apply(open);
    });
    footer.appendChild(btn);
    apply(openRails.has(key));
  });
}
