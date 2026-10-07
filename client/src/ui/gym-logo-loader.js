// Gym logo loading states (E6). Logos are plain <img>s re-created by many renderers, so this is a single
// document-wide observer rather than per-call-site code:
//   - not-yet-loaded logo: invisible, sitting on its container's brand-plate colour (no alt text is ever
//     shown: every logo has alt="" and the owning element carries the accessible name);
//   - loaded from cache/memory (the normal re-render case): visible immediately, no fade (no flicker);
//   - loaded late: fades in (skipped under prefers-reduced-motion);
//   - failed: hidden, and the container shows the gym's initial on the same plate.
import { getGymPresentation } from '../gym-context.js';

const LOGO_SEL = '.ab-gym-logo-img, .ab-gym-logo-svg, .fr-mark-img, .app-hgb-logo img';
const HOLDER_SEL = '.app-gym-chip-logo, .ab-gym-logo, .app-hgb-logo, .fr-gym-dot, .app-gym-mark, .fr-logo-plate';

function initialFor(img) {
  const gymId = img.closest('[data-gym]')?.getAttribute('data-gym') || img.closest('[data-gym-id]')?.getAttribute('data-gym-id');
  const name = (gymId && getGymPresentation(gymId)?.shortName) || img.getAttribute('data-initial') || '';
  return String(name).charAt(0).toUpperCase();
}

function settle(img) {
  if (img instanceof SVGElement) { img.classList.add('is-loaded'); return; } // inline sprite logo: nothing to load
  if (img.classList.contains('is-loaded') || img.classList.contains('is-failed')) return;
  const ok = () => { img.classList.add('is-loaded'); };
  const fail = () => {
    img.classList.add('is-failed');
    const holder = img.closest(HOLDER_SEL) || img.parentElement;
    if (holder) { holder.classList.add('is-logo-fallback'); holder.setAttribute('data-initial', initialFor(img)); }
  };
  if (img.complete) { (img.naturalWidth > 0 ? ok : fail)(); return; }
  img.classList.add('is-late'); // will fade in when it arrives
  img.addEventListener('load', ok, { once: true });
  img.addEventListener('error', fail, { once: true });
}

function scan(node) {
  if (node.nodeType !== 1) return;
  if (node.matches?.(LOGO_SEL)) settle(node);
  node.querySelectorAll?.(LOGO_SEL).forEach(settle);
}

export function initGymLogoLoader() {
  document.documentElement.classList.add('js-logo-fade');
  scan(document.body);
  new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach(scan); })
    .observe(document.body, { childList: true, subtree: true });
}
