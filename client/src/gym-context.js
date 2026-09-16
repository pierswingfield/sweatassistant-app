// The active gym's identity, capabilities and theme (WP-D14).
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

const DEFAULTS = {
  atomicSwap: false,
  nativeWaitlist: false,
  metered: true,
  creditPurchase: true,
  bookmarks: true,
  bookingWindow: 'rolling-weekly',
};

let state = {
  gymId: null,
  name: null,
  capabilities: { ...DEFAULTS },
  theme: null,
  labels: { class: 'class', spot: 'spot' },
  loaded: false,
};

const listeners = new Set();

/** Subscribe to capability changes — fires on load and whenever the linked-gym set changes (link, unlink, re-auth). */
export function onGymContextChange(fn) {
  listeners.add(fn);
  if (state.loaded) fn(state);
  return () => listeners.delete(fn);
}

export function setGymContext(gym) {
  if (!gym) return;
  state = {
    gymId: gym.id ?? null,
    name: gym.name ?? null,
    // Merge over defaults: a gym config missing a flag must not turn the feature
    // off, because `undefined` is falsy and would hide something the gym has.
    capabilities: { ...DEFAULTS, ...(gym.capabilities || {}) },
    theme: gym.theme || null,
    labels: { ...state.labels, ...(gym.labels || {}) },
    loaded: true,
  };
  applyGymTheme(state);
  applyGymName(state);
  for (const fn of listeners) { try { fn(state); } catch (_) {} }
}

/**
 * Fill every static `[data-gym-name]` span in the SPA shell, mirroring how
 * main.js fills `[data-app-name]`.
 *
 * The About pane used to hard-code "Psycle London" and "CodexFit" in prose a JAB
 * user would read, alongside an "(Monday 12PM)" claim that is simply false for a
 * per-class gym. Copy is a capability surface too — it just fails quietly,
 * because nothing throws and the page looks fine.
 */
export function applyGymName(ctx = state) {
  const name = ctx.name;
  if (!name) return; // leave the neutral placeholder until the catalogue loads
  document.querySelectorAll('[data-gym-name]').forEach((el) => {
    el.textContent = name;
  });
}

let linkedGyms = [];

export function setLinkedGyms(gyms) {
  linkedGyms = Array.isArray(gyms) ? gyms : [];
  applyCapabilityGates();
}

export function getLinkedGyms() {
  return linkedGyms;
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
  return can(capability);
}

export function getGymContext() { return state; }
export function can(capability) { return !!state.capabilities[capability]; }

/**
 * A SPECIFIC gym's capability. Use this anywhere a row, card or action belongs
 * to a known gym — which in a merged list is everywhere.
 *
 * `can()` answers for the gym the app happens to resolve to by default, and in
 * a merged timetable that is the wrong gym for most rows: a JAB class was being
 * evaluated against Psycle's `metered: true` and Psycle's credit balance, so
 * with no Psycle credits EVERY row (JAB's membership classes included) showed
 * "Buy Credits". Capability checks in list contexts are per row, not global.
 *
 * Unknown gym → falls back to `can()`, matching the documented rule that an
 * unknown capability defaults ON: briefly showing a feature a gym lacks
 * self-corrects, hiding one it has is permanent and silent.
 */
export function canForGym(capability, gymId) {
  if (!gymId) return can(capability);
  const g = linkedGyms.find((x) => (x.gym_id || x.id) === gymId);
  if (!g || !g.capabilities) return can(capability);
  return !!g.capabilities[capability];
}

/**
 * A SPECIFIC gym's RAW capability value — for a non-boolean flag like
 * `maxSpotsPerClass` (JAB: 1, Psycle: null/unlimited), where `canForGym`'s
 * `!!` coercion would turn `1` into `true` and `null` into `false`, both wrong.
 * Same per-gym reasoning as `canForGym`: a booking modal reads the CLASS's own
 * gym, never the ambient ones.
 */
export function capabilityForGym(capability, gymId) {
  if (!gymId) return state.capabilities[capability];
  const g = linkedGyms.find((x) => (x.gym_id || x.id) === gymId);
  if (!g || !g.capabilities || !(capability in g.capabilities)) return state.capabilities[capability];
  return g.capabilities[capability];
}
export function gymLabel(kind) { return state.labels[kind] || kind; }

/**
 * Stamp the gym onto the document so CSS can theme by it.
 *
 * `data-gym` is the hook; the palette lives in styles.css as a token override
 * block, exactly like the light/dark themes. Deliberately NOT inline styles —
 * those would need `!important` to beat the existing rules and would be
 * invisible to the theme system.
 */
export function applyGymTheme(ctx = state) {
  const root = document.documentElement;
  if (!ctx.gymId) { root.removeAttribute('data-gym'); return; }
  root.setAttribute('data-gym', ctx.gymId);

  // Optional gym font stylesheet injection (loads once)
  if (ctx.theme?.font && !document.getElementById('gym-font')) {
    const link = document.createElement('link');
    link.id = 'gym-font';
    link.rel = 'stylesheet';
    const fontQuery = encodeURIComponent(ctx.theme.font).replace(/%20/g, '+');
    link.href = ctx.theme.font.startsWith('http')
      ? ctx.theme.font
      : `https://fonts.googleapis.com/css2?family=${fontQuery}&display=swap`;
    document.head.appendChild(link);
  }
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
  // single gym for them to belong to. Asking the ambient gym hid the
  // "Bookmarked only" filter whenever the app happened to resolve to a gym
  // without bookmarks, even with the user's bookmarkable classes on screen.
  el.hidden = !canAny(capability);
}

/** Every `[data-requires-capability="x"]` element in the DOM, gated at once. */
export function applyCapabilityGates(root = document) {
  root.querySelectorAll('[data-requires-capability]').forEach((el) => {
    gateByCapability(el, el.getAttribute('data-requires-capability'));
  });
}
