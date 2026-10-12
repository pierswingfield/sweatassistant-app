// [Claude 2026-10-11] One required email field per guest place (no name field), shown inline above the
// CTA. Shared by Auto-Book create/edit and Quick-Book. The CTA stays disabled with a visible message
// until every guest email is valid. Pure of gym knowledge: the caller passes how many guest places exist.
import { escapeHtml } from './cards.js';
import { validateGuestDrafts } from './booking-limits.js';

export function guestFieldsHtml({ idPrefix, drafts = [], count = 0 }) {
  if (count <= 0) return '';
  const fields = Array.from({ length: count }, (_, i) => `
    <label class="app-guest-field">
      <span>${count === 1 ? 'Guest email' : `Guest ${i + 1} email`}</span>
      <input id="${idPrefix}-guest-email-${i}" data-guest-index="${i}" class="app-input" type="email" required
        inputmode="email" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="name@example.com"
        value="${escapeHtml(drafts[i]?.email || '')}">
    </label>`).join('');
  return `<div class="app-guest-fields" data-guest-fields>${fields}<small class="app-guest-msg" data-guest-msg role="status" aria-live="polite"></small></div>`;
}

/** Keep drafts in sync with the inputs and gate the CTA. Returns a function that re-applies the gate. */
export function wireGuestFields(container, { state, count, cta }) {
  const msg = container.querySelector('[data-guest-msg]');
  const apply = () => {
    const result = validateGuestDrafts(state.guestDrafts, count);
    if (cta) cta.disabled = !result.ok;
    if (msg) msg.textContent = result.ok ? '' : result.message;
    return result;
  };
  container.querySelectorAll('[data-guest-index]').forEach((input) => {
    input.addEventListener('input', () => {
      const i = Number(input.dataset.guestIndex);
      state.guestDrafts[i] = { ...(state.guestDrafts[i] || {}), email: input.value.trim() };
      apply();
    });
  });
  return apply;
}
