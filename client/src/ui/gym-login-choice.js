import { appConfig } from '../config.js';
// One disclosure/control for every gym login, always initially unticked.
export const policyLinks = '<a href="/policies/terms.html" data-policy-link>Terms and Conditions</a> and <a href="/policies/privacy.html" data-policy-link>Privacy Policy</a>';
export const sessionNotice = `${appConfig.appName} won’t save copies of your gym login details. You may be asked to log back in more often.`;
export const rememberedNotice = `${appConfig.appName} will securely store copies of your gym login details, and use them on your behalf. More info can be found in the ${policyLinks}.`;
export function gymLoginChoiceHtml(id) {
  return `<div class="app-gym-login-choice app-choice-panel"><label class="app-login-choice-label" for="${id}"><input type="checkbox" id="${id}" data-remember-gym-login aria-describedby="${id}-notice ${id}-detail"> <span class="app-choice-title">Remember your gym login</span></label><p class="app-choice-description" id="${id}-notice" data-gym-login-notice aria-live="polite">${sessionNotice}</p><p class="app-choice-detail" id="${id}-detail">${appConfig.appName} stores an encrypted gym session to keep your connection working. Auto-Book and Auto-Upgrade pause if you need to log in again.</p></div>`;
}
export function bindGymLoginChoice(container) {
  const checkbox = container.querySelector('[data-remember-gym-login]');
  const notice = container.querySelector('[data-gym-login-notice]');
  if (checkbox && notice) checkbox.addEventListener('change', () => { notice.innerHTML = checkbox.checked ? rememberedNotice : sessionNotice; });
}

// A gym is picked but not connected yet: the footer Continue must not read like the "Connect" button
// above it. Low emphasis (quiet outline + fade) but still a real, focusable, enabled button.
export function setContinuePending(button, pending, { label, pendingLabel }) {
  if (!button) return;
  const span = button.querySelector('span') || button;
  span.textContent = pending ? pendingLabel : label;
  if (pending) { button.dataset.quiet = '1'; button.classList.add('is-pending-connect'); }
  else { delete button.dataset.quiet; button.classList.remove('is-pending-connect'); }
}
