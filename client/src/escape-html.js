/**
 * THE shared HTML escaper. Every provider- or server-supplied value that is
 * interpolated into `innerHTML` (text or a quoted attribute) goes through this.
 * `ui/cards.js` re-exports it; `copy.js` imports it directly (cards.js imports
 * copy.js, so the reverse import would be a cycle).
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
