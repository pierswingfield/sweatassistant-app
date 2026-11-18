// /reset-password landing page. It NEVER acts on load (mail scanners pre-open links): the member
// types a new password and submits, which POSTs the token. With no usable token (or a rejected
// one) the page becomes a "request a new link" form, so it doubles as the notice email's help
// page. Standalone: the normal app boot is skipped while it is showing.
import { COPY, formatCopyText } from '../copy.js';
import { appConfig } from '../config.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
export const MIN_PASSWORD = 8;

/** null when this is not the reset path; otherwise { token } ('' when the link carries no usable token). */
export function resetPasswordRequest(loc) {
  if (String(loc.pathname || '').replace(/\/+$/, '') !== '/reset-password') return null;
  const token = new URLSearchParams(loc.search || '').get('token') || '';
  return { token: TOKEN_RE.test(token) ? token : '' };
}

/** Client-side check mirroring the server rule; returns an error message or ''. */
export function validateNewPassword(password, confirm) {
  if (String(password || '').length < MIN_PASSWORD) return COPY.static.resetTooShort;
  if (password !== confirm) return COPY.static.resetMismatch;
  return '';
}

export function showResetPasswordPage({ token }, { reset, forgot, go = () => window.location.assign('/') }) {
  const root = document.getElementById('app-reset-container');
  if (!root) return;
  const $ = (id) => root.querySelector(id);
  const title = $('#app-reset-title');
  const body = $('#app-reset-body');
  const form = $('#app-reset-form');
  const requestForm = $('#app-reset-request-form');
  const errorEl = $('#app-reset-error');
  const msgEl = $('#app-reset-request-msg');
  const cont = $('#app-reset-continue');
  const contWrap = $('#app-reset-continue-wrap');
  const appName = appConfig.appName;
  const say = (el, text) => { el.textContent = text; el.style.display = text ? 'block' : 'none'; };

  // Replace the password form with the "request a new link" form.
  const showRequest = (heading, text) => {
    title.textContent = heading;
    body.textContent = text;
    form.style.display = 'none';
    requestForm.style.display = '';
    cont.style.display = 'none';
    if (contWrap) contWrap.style.display = 'none';
  };

  root.style.display = 'flex';
  requestForm.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#app-reset-request-submit');
    btn.disabled = true;
    try {
      await forgot($('#app-reset-email').value.trim());
      say(msgEl, COPY.static.resetRequestSent);
    } catch (err) {
      say(msgEl, err && err.message ? err.message : COPY.auth.connectionFailed);
    } finally { btn.disabled = false; }
  };

  if (!token) { showRequest(COPY.static.resetRequestTitle, COPY.static.resetRequestBody); return; }

  title.textContent = COPY.static.resetPageTitle;
  body.textContent = formatCopyText(COPY.static.resetPageBody, { appName });
  form.onsubmit = async (e) => {
    e.preventDefault();
    say(errorEl, '');
    const password = $('#app-reset-password').value;
    const problem = validateNewPassword(password, $('#app-reset-confirm').value);
    if (problem) { say(errorEl, problem); return; }
    const btn = $('#app-reset-submit');
    btn.disabled = true;
    btn.querySelector('span').textContent = COPY.static.resetWorking;
    try {
      await reset(token, password);
      title.textContent = COPY.static.resetDoneTitle;
      body.textContent = COPY.static.resetDoneBody;
      form.style.display = 'none';
      cont.textContent = formatCopyText(COPY.static.resetContinue, { appName });
      cont.style.display = '';
      if (contWrap) contWrap.style.display = '';
      cont.onclick = () => go();
    } catch (err) {
      if (err && err.code === 'INVALID_TOKEN') showRequest(COPY.static.resetFailTitle, COPY.static.resetFailBody);
      else say(errorEl, err && err.message ? err.message : COPY.auth.connectionFailed);
      btn.disabled = false;
      btn.querySelector('span').textContent = COPY.static.resetSubmit;
    }
  };
}
