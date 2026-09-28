// Accessible live status line (U2-3).
//
// The Auto-Book tab's per-card status line is fed by SSE and changes rarely
// (planning, attempting, success, failed), unlike the once-a-second countdown
// which lives elsewhere and is deliberately NOT a live region. This is a
// polite, atomic `role="status"` region:
//   - `polite` so it never interrupts what a screen reader is saying;
//   - it only mutates when the TEXT changes, so a repeated identical SSE
//     message is not re-announced;
//   - a region must exist BEFORE its content changes to be announced at all,
//     so a freshly created line is attached empty and filled on the next tick.

const FIRST_FILL_DELAY_MS = 50;

/** Find or create the live status line inside `host`. Returns `{ el, created }`. */
export function ensureLiveStatusLine(host, className = 'autobook-status-line') {
  let el = host.querySelector(`.${className}`);
  if (el) return { el, created: false };
  el = document.createElement('div');
  el.className = className;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  host.appendChild(el);
  return { el, created: true };
}

/**
 * Set the line's text, announcing only real changes. Returns true when the DOM
 * text was (or will be, for a brand-new region) changed.
 */
export function setLiveStatusText(el, text, { created = false } = {}) {
  const next = text == null ? '' : String(text);
  if (created) {
    el._pendingText = next;
    setTimeout(() => {
      if (el._pendingText != null && el.textContent !== el._pendingText) el.textContent = el._pendingText;
      el._pendingText = null;
    }, FIRST_FILL_DELAY_MS);
    return true;
  }
  el._pendingText = null; // a newer write supersedes a pending first fill
  if (el.textContent === next) return false;
  el.textContent = next;
  return true;
}
