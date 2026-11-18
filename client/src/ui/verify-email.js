// /verify-email landing page. It NEVER acts on load (mail scanners pre-open links): the member
// presses a button, which POSTs the token. Works signed in or out; the page is standalone and
// the normal app boot is skipped while it is showing.
import { COPY, formatCopyText } from '../copy.js';
import { appConfig } from '../config.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

/** null when this is not the verify path; otherwise { token } ('' when the link carries no usable token). */
export function verifyEmailRequest(loc) {
  if (String(loc.pathname || '').replace(/\/+$/, '') !== '/verify-email') return null;
  const token = new URLSearchParams(loc.search || '').get('token') || '';
  return { token: TOKEN_RE.test(token) ? token : '' };
}

export function showVerifyEmailPage({ token }, { verify, go = () => window.location.assign('/') }) {
  const root = document.getElementById('app-verify-container');
  if (!root) return;
  const title = root.querySelector('#app-verify-title');
  const body = root.querySelector('#app-verify-body');
  const action = root.querySelector('#app-verify-action');
  const appName = appConfig.appName;
  const finish = (heading, text) => {
    title.textContent = heading;
    body.textContent = text;
    action.disabled = false;
    action.textContent = COPY.static.verifyEmailContinue;
    action.onclick = () => go();
  };
  root.style.display = 'flex';
  if (!token) {
    finish(COPY.static.verifyEmailFailTitle, COPY.static.verifyEmailFailBody);
    return;
  }
  title.textContent = COPY.static.verifyEmailTitle;
  body.textContent = formatCopyText(COPY.static.verifyEmailBody, { appName });
  action.textContent = COPY.static.verifyEmailButton;
  action.onclick = async () => {
    action.disabled = true;
    action.textContent = COPY.static.verifyEmailWorking;
    try {
      await verify(token);
      finish(COPY.static.verifyEmailDoneTitle, COPY.static.verifyEmailDoneBody);
    } catch (_) {
      finish(COPY.static.verifyEmailFailTitle, COPY.static.verifyEmailFailBody);
    }
  };
}
