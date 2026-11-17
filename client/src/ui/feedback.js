// Settings > Send Feedback. One form, rendered into the Settings pane on both layouts
// (on a phone the pane is the full-screen drill-down level, so Back is nav.back()).
// POST /api/feedback stores every submission server-side and may file a GitHub issue;
// the follow-up email never leaves the server. Everything rendered is escaped and every
// handler is bound with addEventListener (CSP: no inline handlers).

import { escapeHtml, icon } from './cards.js';
import { runButton, okResult, failResult } from './async-button.js';
import { appConfig } from '../config.js';

export const FEEDBACK_TYPES = [
  { id: 'bug', label: 'Bug report', icon: 'bug' },
  { id: 'gym', label: 'New gym request', icon: 'location' },
  { id: 'feature', label: 'Feature request', icon: 'star' },
  { id: 'general', label: 'General enquiry', icon: 'info' },
];
export const FEEDBACK_LIMITS = { title: 120, message: 5000, email: 254 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function feedbackCopy(appName = appConfig.appName) {
  return {
    title: `${appName || 'This app'} is in beta and we would like your feedback!`,
    subtitle: 'Something broken? Want a gym added? Have a great idea for a feature? Use the form to share it with us.',
    followUp: 'Can we follow up with you?',
  };
}

/** Client-side validation mirroring the server's. Returns { field: message }. */
export function validateFeedback({ type, title, message, email }) {
  const errors = {};
  if (!FEEDBACK_TYPES.some((t) => t.id === type)) errors.type = 'Choose a type.';
  const t = String(title || '').trim();
  if (!t) errors.title = 'Add a short title.';
  else if (t.length > FEEDBACK_LIMITS.title) errors.title = `Keep the title under ${FEEDBACK_LIMITS.title} characters.`;
  const m = String(message || '').trim();
  if (!m) errors.message = 'Tell us a little more.';
  else if (m.length > FEEDBACK_LIMITS.message) errors.message = `Keep the message under ${FEEDBACK_LIMITS.message} characters.`;
  const e = String(email || '').trim();
  if (e && (e.length > FEEDBACK_LIMITS.email || !EMAIL_RE.test(e))) errors.email = 'Enter a valid email address, or leave it blank.';
  return errors;
}

// eslint-disable-next-line no-undef
const BUILD = typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : 'dev';

function formHtml(copy, accountEmail) {
  const types = FEEDBACK_TYPES.map((t) => `
      <label class="app-feedback-type">
        <input type="radio" name="type" value="${escapeHtml(t.id)}">
        <span class="app-feedback-type-body"><span class="app-feedback-type-ico" aria-hidden="true">${icon(t.icon, 18)}</span><span class="app-feedback-type-label">${escapeHtml(t.label)}</span></span>
      </label>`).join('');
  return `
  <section class="app-settings-card app-feedback-card">
    <header class="app-feedback-hero">
      <span class="app-feedback-badge">Beta</span>
      <h3 class="app-feedback-title">${escapeHtml(copy.title)}</h3>
      <p class="app-feedback-sub">${escapeHtml(copy.subtitle)}</p>
    </header>
    <form class="app-feedback-form" novalidate>
      <fieldset class="app-feedback-field" data-field="type" aria-describedby="app-feedback-err-type">
        <legend class="app-feedback-label">Type <span class="app-feedback-req" aria-hidden="true">*</span></legend>
        <div class="app-feedback-types" role="radiogroup" aria-required="true">${types}</div>
        <p class="app-feedback-error" id="app-feedback-err-type" role="alert"></p>
      </fieldset>
      <div class="app-feedback-field" data-field="title">
        <label class="app-feedback-label" for="app-feedback-title">Title <span class="app-feedback-req" aria-hidden="true">*</span></label>
        <input class="app-input app-feedback-input" id="app-feedback-title" name="title" type="text" maxlength="${FEEDBACK_LIMITS.title}" autocomplete="off" required aria-describedby="app-feedback-err-title" placeholder="A few words that sum it up">
        <p class="app-feedback-error" id="app-feedback-err-title" role="alert"></p>
      </div>
      <div class="app-feedback-field" data-field="message">
        <label class="app-feedback-label" for="app-feedback-message">Message <span class="app-feedback-req" aria-hidden="true">*</span></label>
        <textarea class="app-input app-feedback-input app-feedback-textarea" id="app-feedback-message" name="message" rows="6" maxlength="${FEEDBACK_LIMITS.message}" required aria-describedby="app-feedback-err-message app-feedback-count" placeholder="What happened, what you expected, or what you'd love to see"></textarea>
        <div class="app-feedback-meta"><p class="app-feedback-error" id="app-feedback-err-message" role="alert"></p><span class="app-feedback-count" id="app-feedback-count">0 / ${FEEDBACK_LIMITS.message}</span></div>
      </div>
      <div class="app-feedback-followup">
        <h4 class="app-feedback-section">${escapeHtml(copy.followUp)}</h4>
        <div class="app-feedback-field" data-field="email">
          <label class="app-feedback-label" for="app-feedback-email">Email address <span class="app-feedback-optional">Optional</span></label>
          <input class="app-input app-feedback-input" id="app-feedback-email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="${FEEDBACK_LIMITS.email}" aria-describedby="app-feedback-err-email" value="${escapeHtml(accountEmail || '')}">
          <p class="app-feedback-error" id="app-feedback-err-email" role="alert"></p>
        </div>
      </div>
      <p class="app-feedback-form-error" role="alert" hidden></p>
      <button type="submit" class="app-btn-primary app-feedback-submit">Submit</button>
    </form>
  </section>`;
}

function thanksHtml() {
  return `
  <section class="app-settings-card app-feedback-card app-feedback-thanks" tabindex="-1">
    <span class="app-feedback-thanks-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>
    <h3 class="app-feedback-title">Thank you!</h3>
    <p class="app-feedback-sub">Your feedback is with us. Every message is read, and if you left an email we may follow up.</p>
    <button type="button" class="app-btn-secondary app-feedback-again">Send more feedback</button>
  </section>`;
}

async function defaultSubmit(payload) {
  const { apiFetch } = await import('../api');
  const res = await apiFetch('/api/feedback', { method: 'POST', body: JSON.stringify(payload) });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Render the feedback form into `root`.
 * opts.submit(payload) -> { ok, status, data } (injectable for tests)
 * opts.accountEmail: prefill for the optional email field
 */
export function renderFeedbackForm(root, opts = {}) {
  if (!root) return;
  const submit = opts.submit || defaultSubmit;
  const copy = feedbackCopy(opts.appName);
  root.innerHTML = formHtml(copy, opts.accountEmail);
  const form = root.querySelector('form');
  const btn = form.querySelector('.app-feedback-submit');
  const formError = form.querySelector('.app-feedback-form-error');
  const count = form.querySelector('#app-feedback-count');
  const message = form.querySelector('#app-feedback-message');

  const setError = (field, text) => {
    const wrap = form.querySelector(`[data-field="${field}"]`);
    const el = form.querySelector(`#app-feedback-err-${field}`);
    if (!wrap || !el) return;
    wrap.classList.toggle('has-error', !!text);
    el.textContent = text || '';
    const input = wrap.querySelector('input:not([type="radio"]), textarea');
    if (input) { if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  };
  const read = () => ({
    type: form.querySelector('input[name="type"]:checked')?.value || '',
    title: form.querySelector('#app-feedback-title').value,
    message: message.value,
    email: form.querySelector('#app-feedback-email').value,
  });
  const showErrors = (errors) => {
    for (const f of ['type', 'title', 'message', 'email']) setError(f, errors[f]);
    const first = ['type', 'title', 'message', 'email'].find((f) => errors[f]);
    if (first) form.querySelector(`[data-field="${first}"] input, [data-field="${first}"] textarea`)?.focus();
  };

  const updateCount = () => {
    const n = message.value.length;
    count.textContent = `${n} / ${FEEDBACK_LIMITS.message}`;
    count.classList.toggle('is-near', n > FEEDBACK_LIMITS.message * 0.9);
  };
  message.addEventListener('input', updateCount);
  // Clear a field's error as soon as the member fixes it.
  form.addEventListener('input', (e) => {
    const field = e.target.closest('[data-field]')?.getAttribute('data-field');
    if (field && form.querySelector(`[data-field="${field}"]`).classList.contains('has-error')) {
      const errs = validateFeedback(read());
      setError(field, errs[field]);
    }
  });
  form.addEventListener('change', (e) => { if (e.target.name === 'type') setError('type', ''); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    formError.hidden = true;
    const values = read();
    const errors = validateFeedback(values);
    if (Object.keys(errors).length) {
      showErrors(errors);
      runButton(btn, () => failResult('invalid'), { errorLabel: 'Please check the highlighted fields.' });
      return;
    }
    runButton(btn, async () => {
      let out;
      try {
        out = await submit({ ...values, title: values.title.trim(), message: values.message.trim(), email: values.email.trim(), build: BUILD });
      } catch {
        out = { ok: false, data: { message: 'Could not reach the server. Check your connection and try again.' } };
      }
      if (!out || !out.ok) {
        if (out?.data?.errors) showErrors(out.data.errors);
        formError.textContent = out?.data?.message || 'Could not send your feedback. Please try again.';
        formError.hidden = false;
        return failResult(formError.textContent);
      }
      return okResult(out.data);
    }, { successLabel: 'Feedback sent', errorLabel: 'Feedback not sent', rethrow: false }).then((result) => {
      if (!result || result.ok !== true) return;
      root.innerHTML = thanksHtml();
      const thanks = root.querySelector('.app-feedback-thanks');
      thanks.focus({ preventScroll: true });
      thanks.querySelector('.app-feedback-again').addEventListener('click', () => {
        renderFeedbackForm(root, { ...opts, accountEmail: values.email || opts.accountEmail });
        root.querySelector('input[name="type"]')?.focus();
      });
    });
  });
}
