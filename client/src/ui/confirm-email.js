// /confirm-email landing page (confirm a requested email change). It NEVER acts on load (mail
// scanners pre-open links): the member presses a button, which POSTs the token. Standalone: the
// normal app boot is skipped while it is showing. Success stores the fresh session token.
import { COPY, formatCopyText } from '../copy.js';
import { appConfig } from '../config.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

/** null when this is not the confirm path; otherwise { token } ('' when the link carries no usable token). */
export function confirmEmailRequest(loc) {
  if (String(loc.pathname || '').replace(/\/+$/, '') !== '/confirm-email') return null;
  const token = new URLSearchParams(loc.search || '').get('token') || '';
  return { token: TOKEN_RE.test(token) ? token : '' };
}

export function showConfirmEmailPage({ token }, { confirm, go = () => window.location.assign('/') }) {
  const root = document.getElementById('app-confirm-email-container');
  if (!root) return;
  const title = root.querySelector('#app-confirm-email-title');
  const body = root.querySelector('#app-confirm-email-body');
  const action = root.querySelector('#app-confirm-email-action');
  const finish = (heading, text) => {
    title.textContent = heading;
    body.textContent = text;
    action.disabled = false;
    action.textContent = COPY.static.verifyEmailContinue;
    action.onclick = () => go();
  };
  root.style.display = 'flex';
  if (!token) {
    finish(COPY.static.confirmEmailFailTitle, COPY.static.confirmEmailFailBody);
    return;
  }
  title.textContent = COPY.static.confirmEmailTitle;
  body.textContent = formatCopyText(COPY.static.confirmEmailBody, { appName: appConfig.appName });
  action.textContent = COPY.static.confirmEmailButton;
  action.onclick = async () => {
    action.disabled = true;
    action.textContent = COPY.static.verifyEmailWorking;
    try {
      await confirm(token);
      finish(COPY.static.confirmEmailDoneTitle, COPY.static.confirmEmailDoneBody);
    } catch (_) {
      finish(COPY.static.confirmEmailFailTitle, COPY.static.confirmEmailFailBody);
    }
  };
}
