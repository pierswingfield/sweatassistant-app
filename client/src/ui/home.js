// Home tab: a page of independent widgets (F-10-1).
// Framework lives in widget-registry.js; this file registers the widgets and paints the page.
import { api } from '../api.js';
import { COPY } from '../copy.js';
import { registerWidget, registry, mountWidget, isNoGymError } from './widget-registry.js';
import { renderCardSkeletons } from './loading-skeleton.js';

const goTo = (tabId) => (window.switchTab ? window.switchTab(tabId) : null);

// Eight widgets in the agreed order. W1-W3 and W5-W8 are placeholders that later
// items (F-10-2 ... F-10-9) fill in; W4 is the first real one.
const PLACEHOLDERS = [
  ['welcome', 'welcome', 10], ['book', 'book', 20], ['upcoming', 'upcoming', 30],
  ['credits', 'credits', 50], ['favourites', 'favourites', 60],
  ['top-instructors', 'topInstructors', 70], ['stats', 'stats', 80],
];
for (const [id, key, order] of PLACEHOLDERS) {
  registerWidget({
    id, order, title: COPY.home[key],
    load: async () => null,
    isEmpty: () => true,
    emptyText: COPY.home.comingSoon,
    render() {},
  });
}

/** Pending = still in the queue (not executed), across every linked gym. */
export function countPendingAutoBooks(rows) {
  if (!Array.isArray(rows)) return null; // not loaded is not zero
  return rows.filter((r) => !r.executed_at).length;
}

registerWidget({
  id: 'auto-book-count', order: 40, title: COPY.home.autoBook,
  async load() { return countPendingAutoBooks(await api.getAutoBookings()); },
  render(el, count) {
    const n = count ?? 0;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home-stat-tile';
    btn.innerHTML = `<span class="home-stat-number"></span><span class="home-stat-label"></span>`;
    btn.querySelector('.home-stat-number').textContent = String(n);
    btn.querySelector('.home-stat-label').textContent = n === 0 ? COPY.home.autoBookNone : (n === 1 ? COPY.home.autoBookOne : COPY.home.autoBookActive);
    btn.addEventListener('click', () => goTo('auto-book'));
    el.appendChild(btn);
  },
});

let host = null;
let renderRun = 0;

function widgetCopy() {
  return { empty: COPY.home.comingSoon, error: COPY.home.error, retry: COPY.home.retry, noGym: COPY.home.noGymWidget };
}

function renderConnectGym(root) {
  root.innerHTML = `<div class="home-connect-gym"><h4></h4><p></p><button type="button" class="home-connect-btn"></button></div>`;
  root.querySelector('h4').textContent = COPY.home.connectGymTitle;
  root.querySelector('p').textContent = COPY.home.connectGymBody;
  const b = root.querySelector('button');
  b.textContent = COPY.home.connectGymAction;
  b.addEventListener('click', () => goTo('settings'));
}

/** (Re)paint the whole page. Safe to call repeatedly; a newer call supersedes an older one. */
export async function renderHome() {
  host = host || document.getElementById('psycle-home-widgets');
  if (!host) return;
  const run = ++renderRun;
  let gyms = null;
  try { gyms = (await api.getMyGyms()).gyms || []; } catch (_) { /* widgets still try on their own */ }
  if (run !== renderRun) return;
  if (Array.isArray(gyms) && gyms.length === 0) { renderConnectGym(host); return; }
  const ctx = { gyms, navigate: goTo };
  const widgets = registry.list(ctx);
  host.innerHTML = '';
  const skeleton = () => renderCardSkeletons(1, COPY.home.loadingWidget);
  for (const w of widgets) {
    const el = document.createElement('section');
    el.className = 'home-widget';
    el.dataset.widgetId = w.id;
    host.appendChild(el);
    mountWidget(el, w, ctx, { skeleton, copy: widgetCopy() }); // independent; never awaited together
  }
}

export function initHome() { return renderHome(); }
export const refreshHome = renderHome;

export { isNoGymError };

// Re-render when the linked-gym set changes, and when the app returns to the foreground.
if (typeof window !== 'undefined') {
  const onHome = () => !!document.getElementById('psycle-panel-home') && document.getElementById('psycle-panel-home').style.display !== 'none';
  window.addEventListener('sweat:gyms-changed', () => { if (onHome()) renderHome(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && onHome()) renderHome(); });
}
