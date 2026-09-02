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

/** Subscribe to capability changes — fires on load and on every gym switch. */
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

export function getGymContext() { return state; }
export function can(capability) { return !!state.capabilities[capability]; }
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

  // A gym may name a font its brand uses. Loaded on demand rather than shipped
  // for every gym — a Psycle user should not download JAB's typeface.
  const font = ctx.theme && ctx.theme.font;
  if (font && !document.getElementById('gym-font')) {
    const link = document.createElement('link');
    link.id = 'gym-font';
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, '+')}:wght@400;500;600;700&display=swap`;
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
  el.hidden = !can(capability);
}

/** Every `[data-requires-capability="x"]` element in the DOM, gated at once. */
export function applyCapabilityGates(root = document) {
  root.querySelectorAll('[data-requires-capability]').forEach((el) => {
    gateByCapability(el, el.getAttribute('data-requires-capability'));
  });
}
