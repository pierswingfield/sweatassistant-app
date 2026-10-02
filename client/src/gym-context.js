import { loadWordmarkSprites } from './gym-logo-sprite.js';
import { COPY } from './copy.js';
// Per-gym capabilities, theming and labels (WP-D14).
//
// Everything above the adapter layer is supposed to know only normalized types
// and capability flags — this is where the client holds those flags. Before it
// existed the UI simply assumed CodexFit's feature set: it rendered Buy Credits
// and Bookmarks for every gym, both of which fail against MarianaTek.
//
// Two rules for reading capabilities:
//
//   1. Never branch on gym id. `if (gymId === 'jab-boxing')` is the shape this
//      whole phase exists to remove — it makes the third gym another branch.
//      Ask what the gym CAN DO, not which gym it is.
//   2. Default to the CodexFit-shaped answer while flags are unknown. The
//      catalogue is fetched asynchronously, and a feature briefly appearing and
//      then hiding is a much smaller failure than a feature the gym has being
//      hidden forever because a request was slow.
//
// C3-6: there used to be a THIRD thing here — a module-level `state` plus
// `setGymContext()`/`getGymContext()`/`can()`, an ambient "the active gym" the
// whole module defaulted to whenever a caller didn't pass one. That was the
// client twin of the server-side "active gym" bug class removed 2026-09-16:
// on a multi-gym account, anything reading it got a guess, not an answer. An
// audit of every call site found it was already dead weight in practice —
// every real production call to `canForGym`/`capabilityForGym` already passed
// an explicit `gymId` (`event.gymId`, `c.gymId`, …), `can()` had no production
// caller at all, and `getGymContext()` had exactly one (a settings.js compare
// against "the default gym", now reading `getLinkedGyms()[0]` directly instead
// — the same source `setGymContext` used to seed itself from). Removed
// entirely; `canForGym`/`capabilityForGym`/`canAny` now fall back straight to
// `DEFAULTS` (still permissive-unknown-defaults-ON) instead of a guessed gym's
// flags. Theming and the About page's `[data-gym-name]` copy — the other two
// things the ambient gym used to drive — are now genuinely gym-agnostic: see
// `applyGymFonts()`/`applyGymNames()` below, which act on every linked gym
// rather than picking one.

const DEFAULTS = {
  atomicSwap: false,
  nativeWaitlist: false,
  metered: true,
  creditPurchase: true,
  bookmarks: true,
  bookingWindow: 'rolling-weekly',
};

let linkedGyms = [];
// Presentation contracts from GET /api/gyms, keyed by EXACT gym id (F-7 item 2).
// Held apart from `linkedGyms` so a gym that is in the catalogue but not linked
// (or not yet linked when a row renders) still resolves its own brand.
let presentations = new Map();
// Gym default display zone from the catalogue (GET /api/gyms `timezone`), by gym id.
let gymZones = new Map();

/** Gym-local IANA zone from the catalogue, or '' when unknown/not loaded. */
export function getGymTimeZone(gymId) {
  return (gymId && gymZones.get(String(gymId))) || '';
}

/** Seed presentation contracts from the /api/gyms catalogue array. */
export function setGymCatalogue(catalogue) {
  presentations = new Map();
  gymZones = new Map();
  for (const g of Array.isArray(catalogue) ? catalogue : []) {
    if (g && g.id && g.timezone) gymZones.set(String(g.id), g.timezone);
    if (g && g.id && g.presentation) presentations.set(String(g.id), g.presentation);
  }
  injectGymPresentationCss();
  preloadGymWordmarks();
  loadWordmarkSprites(presentations);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('gym-catalogue-ready'));
}

// Logos are re-created by every card re-render. Hold one decoded Image per wordmark asset so a
// re-inserted <img> paints from memory immediately instead of flashing blank while the browser
// re-decodes the AVIF/SVG (the Auto-Book logo flicker).
const heldWordmarks = new Map();
function preloadGymWordmarks() {
  if (typeof Image === 'undefined') return;
  for (const p of presentations.values()) {
    for (const k of ['full', 'compact', 'mark']) {
      const src = p?.wordmark?.[k]?.src;
      if (!src || heldWordmarks.has(src)) continue;
      const im = new Image();
      im.decoding = 'sync';
      im.src = src;
      heldWordmarks.set(src, im);
      im.decode?.().catch(() => {});
    }
  }
}

const CSS_ID_OK = /^[\w-]+$/;
// btn / wash / pip are optional in the contract; fall back so older contracts render as before.
const tokens = (id, c) => `--gym-${id}-ink:${c.ink};--gym-${id}-ink-hover:${c.inkHover};--gym-${id}-tint:${c.tint};--gym-${id}-on:${c.on};`
  + `--gym-${id}-btn:${c.btn || c.ink};--gym-${id}-wash:${c.wash || 'transparent'};--gym-${id}-pip:${c.pip || c.ink};`;

/**
 * CSS for every gym's colour tokens, built from the presentation contracts so
 * styles.css names no gym (F-7 item 3). Emits `--gym-<id>-*` on :root for each
 * theme, plus `[data-gym="<id>"]` rules that alias them to the generic
 * `--gym-ink/-ink-hover/-tint/-on` the shared selectors consume.
 */
export function gymPresentationCss(map = presentations) {
  let dark = '', light = '', alias = '';
  for (const [id, p] of map) {
    if (!CSS_ID_OK.test(id) || !p?.dark || !p?.light) continue;
    dark += tokens(id, p.dark);
    light += tokens(id, p.light);
    alias += `[data-gym="${id}"]{--gym-ink:var(--gym-${id}-ink);--gym-ink-hover:var(--gym-${id}-ink-hover);--gym-tint:var(--gym-${id}-tint);--gym-on:var(--gym-${id}-on);--gym-btn:var(--gym-${id}-btn);--gym-wash:var(--gym-${id}-wash);--gym-pip:var(--gym-${id}-pip);}`;
  }
  if (!alias) return '';
  return `:root{${dark}}`
    + `@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${light}}}`
    + `:root[data-theme="light"]{${light}}`
    + alias;
}

function injectGymPresentationCss() {
  if (typeof document === 'undefined') return;
  let el = document.getElementById('gym-presentation-tokens');
  if (!el) {
    el = document.createElement('style');
    el.id = 'gym-presentation-tokens';
    document.head.appendChild(el);
  }
  el.textContent = gymPresentationCss();
}

/**
 * A gym's presentation contract by exact id, or null when the catalogue has not
 * supplied one. Callers render a neutral fallback for null; they never guess a
 * brand from the id's spelling.
 */
export function getGymPresentation(gymId) {
  const id = String(gymId ?? '');
  if (presentations.has(id)) return presentations.get(id);
  const g = linkedGyms.find((x) => (x.gym_id || x.id) === id);
  return g?.presentation || null;
}

/**
 * Display-only alias for a raw provider name, scoped to the owning gym and a
 * scope ("studios"). Keys are trimmed lower-case. Returns the raw name when the
 * gym has no alias, so lookups, floor plans and API calls are never affected.
 */
export function getDisplayAlias(gymId, scope, name) {
  const raw = name == null ? '' : String(name);
  const map = getGymPresentation(gymId)?.displayAliases?.[scope];
  return (map && map[raw.trim().toLowerCase().replace(/\s+/g, ' ')]) || raw;
}

/**
 * STRICT: true only when this exact gym is linked AND its catalogue entry
 * positively says `bookingWindow: 'rolling-weekly'`. Unlike `canForGym` this has
 * no unknown-defaults-ON fallback, because a wrong "yes" here means computing
 * Psycle's Monday-noon instant for another gym's class (F-7 item 5).
 */
export function isRollingWeeklyGym(gymId) {
  if (!gymId) return false;
  const g = linkedGyms.find((x) => String(x.gym_id || x.id) === String(gymId));
  return g?.capabilities?.bookingWindow === 'rolling-weekly';
}

export function setLinkedGyms(gyms) {
  linkedGyms = Array.isArray(gyms) ? gyms : [];
  applyGymFonts();
  applyGymNames();
  applyCapabilityGates();
}

/**
 * The gym to assume when a row/event carries no gym id: the first linked gym,
 * else the first catalogue entry, else '' (which renders the neutral brand).
 * Never a literal id — nothing client-side may privilege one gym (F-7 item 5).
 */
export function getDefaultGymId() {
  const l = linkedGyms[0];
  if (l && (l.gym_id || l.id)) return String(l.gym_id || l.id);
  const first = presentations.keys().next();
  return first.done ? '' : first.value;
}

export function getLinkedGyms() {
  return linkedGyms;
}

/**
 * Fill every static `[data-gym-name]` span in the SPA shell, mirroring how
 * main.js fills `[data-app-name]`.
 *
 * The About pane used to hard-code "Psycle London" and "CodexFit" in prose a JAB
 * user would read, alongside an "(Monday 12PM)" claim that is simply false for a
 * per-class gym. Copy is a capability surface too — it just fails quietly,
 * because nothing throws and the page looks fine.
 *
 * A multi-gym account has no single "your gym" to name here, so this joins
 * every linked gym's name rather than guessing one (the ambient `state.name`
 * this used to read was always whichever gym happened to be linked[0]).
 */
export function applyGymNames() {
  const names = linkedGyms.map((g) => g.shortName || g.name).filter(Boolean);
  if (!names.length) return; // leave the neutral placeholder until the catalogue loads
  const joined = names.length > 1 ? names.join(COPY.common.gymNameJoiner) : names[0];
  document.querySelectorAll('[data-gym-name]').forEach((el) => {
    el.textContent = joined;
  });
}

/**
 * The short label for a gym ('Psycle', 'JAB') — from `gyms.config.js`'s
 * `shortName` (merged in via the catalogue in `loadGymContext()`), never a
 * hardcoded per-gym-id ternary. Falls back to the full name, then the id
 * itself, so an unlinked or not-yet-loaded gym still renders something.
 */
export function getGymShortName(gymId) {
  const g = linkedGyms.find((x) => (x.gym_id || x.id) === gymId);
  return g?.shortName || g?.name || gymId || '';
}

/**
 * Short display alias for a location ("Oxford Circus" -> "OC"), from the gym's
 * `locationAliases` in gyms.config.js (via the catalogue). Pass the location
 * name with the gym prefix already trimmed. Returns null when there is no
 * alias, so callers fall back to the full name. Display-only.
 */
export function getLocationAlias(gymId, name) {
  const g = linkedGyms.find((x) => (x.gym_id || x.id) === gymId);
  const key = String(name || '').trim().toLowerCase();
  return (g?.locationAliases && g.locationAliases[key]) || null;
}

export function canAny(capability) {
  if (linkedGyms && linkedGyms.length > 0) {
    return linkedGyms.some((g) => !!(g.capabilities && g.capabilities[capability]));
  }
  // No linked gym at all (post-signup, or every gym unlinked) — nothing to be
  // permissive OR restrictive about correctly, so fall back to the same
  // unknown-defaults-ON answer a genuinely unknown gym would get.
  return !!DEFAULTS[capability];
}

/**
 * A SPECIFIC gym's capability. Use this anywhere a row, card or action belongs
 * to a known gym — which in a merged list is everywhere.
 *
 * In a merged timetable, a JAB class evaluated against an ambient "default"
 * gym's flags was the bug WP-D14 exists to prevent: with the default resolving
 * to Psycle, EVERY row (JAB's membership classes included) showed "Buy
 * Credits". Capability checks in list contexts are per row, not global.
 *
 * No gym, or a gym this account isn't (yet) linked to → `DEFAULTS`, matching
 * the documented rule that an unknown capability defaults ON: briefly showing
 * a feature a gym lacks self-corrects, hiding one it has is permanent and
 * silent.
 */
export function canForGym(capability, gymId) {
  if (!gymId) return !!DEFAULTS[capability];
  const g = linkedGyms.find((x) => (x.gym_id || x.id) === gymId);
  if (!g || !g.capabilities || !(capability in g.capabilities)) return !!DEFAULTS[capability];
  return !!g.capabilities[capability];
}

/**
 * A SPECIFIC gym's RAW capability value — for a non-boolean flag like
 * `maxSpotsPerClass` (JAB: 1, Psycle: null/unlimited), where `canForGym`'s
 * `!!` coercion would turn `1` into `true` and `null` into `false`, both wrong.
 * Same per-gym reasoning as `canForGym`: a booking modal reads the CLASS's own
 * gym, never a guessed one.
 */
export function capabilityForGym(capability, gymId) {
  if (!gymId) return DEFAULTS[capability];
  const g = linkedGyms.find((x) => (x.gym_id || x.id) === gymId);
  if (!g || !g.capabilities || !(capability in g.capabilities)) return DEFAULTS[capability];
  return g.capabilities[capability];
}

/**
 * Load every linked gym's custom font, if any — idempotent per gym (keyed by
 * id, not a single shared `#gym-font` element), so a two-gym account with two
 * custom fonts gets both rather than whichever gym's font a single ambient
 * slot last saw.
 */
export function applyGymFonts() {
  linkedGyms.forEach((g) => {
    const font = g.theme?.font;
    const gymId = g.gym_id || g.id;
    if (!font || !gymId) return;
    const elId = `gym-font-${gymId}`;
    if (document.getElementById(elId)) return;
    const link = document.createElement('link');
    link.id = elId;
    link.rel = 'stylesheet';
    const fontQuery = encodeURIComponent(font).replace(/%20/g, '+');
    link.href = font.startsWith('http')
      ? font
      : `https://fonts.googleapis.com/css2?family=${fontQuery}&display=swap`;
    document.head.appendChild(link);
  });
}

/**
 * Show or hide an element by capability. Uses the `hidden` attribute rather than
 * an inline `display`, so it can't fight whatever display mode the element's own
 * CSS wants (flex, grid, inline-flex…).
 */
export function gateByCapability(el, capability) {
  if (!el) return;
  // ANY linked gym, always. These gates sit on global chrome (nav tabs, header
  // badges, the timetable's own filter bar) above a MERGED list, so there is no
  // single gym for them to belong to. Asking an ambient "default" gym hid the
  // "Bookmarked only" filter whenever that gym happened to lack bookmarks,
  // even with the user's bookmarkable classes on screen.
  el.hidden = !canAny(capability);
}

/** Every `[data-requires-capability="x"]` element in the DOM, gated at once. */
export function applyCapabilityGates(root = document) {
  root.querySelectorAll('[data-requires-capability]').forEach((el) => {
    gateByCapability(el, el.getAttribute('data-requires-capability'));
  });
}
