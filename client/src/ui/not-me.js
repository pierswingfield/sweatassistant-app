// /not-me landing page ("I did NOT create this account"). It NEVER acts on load (mail scanners
// pre-open links): the member solves a Cloudflare Turnstile check, then presses the button twice
// (first press arms "Press again to confirm", second submits). Standalone: the normal app boot is
// skipped while it is showing. The Turnstile script is loaded from code (CSP forbids inline script;
// the server allows challenges.cloudflare.com on this path only).
import { COPY, formatCopyText } from '../copy.js';
import { appConfig } from '../config.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;
const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** null when this is not the not-me path; otherwise { token } ('' when the link carries no usable token). */
export function notMeRequest(loc) {
  if (String(loc.pathname || '').replace(/\/+$/, '') !== '/not-me') return null;
  const token = new URLSearchParams(loc.search || '').get('token') || '';
  return { token: TOKEN_RE.test(token) ? token : '' };
}

/** Two-press confirm state machine: press() returns 'armed' on the first press, 'confirmed' on the second. */
export function createTwoPress() {
  let armed = false;
  return {
    press() { if (armed) return 'confirmed'; armed = true; return 'armed'; },
    reset() { armed = false; },
    get armed() { return armed; },
  };
}

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TURNSTILE_SRC; s.async = true; s.defer = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
    s.onerror = () => reject(new Error('turnstile'));
    document.head.appendChild(s);
  });
}

export function showNotMePage({ token }, { preview, submit, siteKey = appConfig.turnstileSiteKey, loadWidget = loadTurnstile }) {
  const root = document.getElementById('app-notme-container');
  if (!root) return;
  const title = root.querySelector('#app-notme-title');
  const body = root.querySelector('#app-notme-body');
  const action = root.querySelector('#app-notme-action');
  const widgetEl = root.querySelector('#app-notme-widget');
  const end = (heading, text) => { title.textContent = heading; body.textContent = text; action.hidden = true; if (widgetEl) widgetEl.hidden = true; };
  root.style.display = 'flex';
  if (!token) return end(COPY.static.notMeFailTitle, COPY.static.notMeFailBody);
  if (!siteKey) return end(COPY.static.notMeUnavailableTitle, COPY.static.notMeUnavailableBody);

  const press = createTwoPress();
  let turnstileToken = '';
  let widgetId = null;
  let api = null;
  let bodyText = '';
  const idle = () => { press.reset(); action.textContent = COPY.static.notMeButton; action.disabled = !turnstileToken; };

  action.disabled = true;
  (async () => {
    let address;
    try { address = await preview(token); } catch (_) { return end(COPY.static.notMeFailTitle, COPY.static.notMeFailBody); }
    title.textContent = COPY.static.notMeTitle;
    bodyText = formatCopyText(COPY.static.notMeBody, { appName: appConfig.appName, address });
    body.textContent = bodyText;
    try {
      api = await loadWidget();
      widgetId = api.render(widgetEl, {
        sitekey: siteKey,
        action: 'not_me',
        callback: (t) => { turnstileToken = t; idle(); },
        'expired-callback': () => { turnstileToken = ''; idle(); },
        'error-callback': () => { turnstileToken = ''; idle(); },
      });
    } catch (_) { end(COPY.static.notMeUnavailableTitle, COPY.static.notMeUnavailableBody); }
  })();

  action.onclick = async () => {
    if (!turnstileToken) return;
    if (press.press() === 'armed') { action.textContent = COPY.static.notMeConfirm; return; }
    action.disabled = true;
    action.textContent = COPY.static.notMeWorking;
    try {
      await submit(token, turnstileToken);
      end(COPY.static.notMeDoneTitle, COPY.static.notMeDoneBody);
    } catch (err) {
      if (err && err.code === 'INVALID_TOKEN') return end(COPY.static.notMeFailTitle, COPY.static.notMeFailBody);
      if (err && err.code === 'NOT_ME_UNAVAILABLE') return end(COPY.static.notMeUnavailableTitle, COPY.static.notMeUnavailableBody);
      // Turnstile tokens are single use: get a fresh one before another try.
      turnstileToken = '';
      try { if (api && widgetId != null) api.reset(widgetId); } catch (_) { /* ignore */ }
      idle();
      body.textContent = `${bodyText} ${COPY.static.notMeCheckFailed}`;
    }
  };
}
