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

export function setLinkedGyms(gyms) {
  linkedGyms = Array.isArray(gyms) ? gyms : [];
  applyGymFonts();
  applyGymNames();
  applyCapabilityGates();
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
  const joined = names.length > 1 ? names.join(' and ') : names[0];
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
