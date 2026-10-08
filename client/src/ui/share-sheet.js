// Share My Bookings drawer (F-3). Reuses the filter drawer's shell (.fr-sheet*),
// layer handling and drag-to-dismiss; selection and text live in share-bookings.js.
import { api } from '../api';
import { cache, showToast } from '../main';
import { appConfig } from '../config.js';
import { COPY, formatCopyText } from '../copy.js';
import { getLinkedGyms } from '../gym-context.js';
import { pushLayer } from './modal-nav.js';
import { gymPlate, wireDragToDismiss } from './filter-rail.js';
import { escapeHtml } from './cards.js';
import {
  SHARE_WINDOWS, DEFAULT_SHARE_WINDOW, buildShareItems, filterShareItems,
  countShareItems, formatShare, gymsWithUpcoming, pickFirstName,
} from './share-bookings.js';

const WINDOW_KEY = 'appShareWindow';
let overlay = null;
let layer = null;

function loadWindow() {
  try {
    const v = localStorage.getItem(WINDOW_KEY);
    if (SHARE_WINDOWS.some((w) => w.id === v)) return v;
  } catch { /* storage unavailable */ }
  return DEFAULT_SHARE_WINDOW;
}
function saveWindow(id) { try { localStorage.setItem(WINDOW_KEY, id); } catch { /* ignore */ } }

export function closeShareSheet() {
  if (!overlay) return;
  if (layer) { const l = layer; layer = null; l.release(); }
  const el = overlay;
  overlay = null;
  el.classList.remove('open');
  setTimeout(() => el.remove(), 280);
}

// Rich copy: text/html (real bold and bullets for email, Notes, Docs) alongside
// text/plain (what WhatsApp and iMessage take). Falls back to plain text only.
async function copyText({ text, html }) {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return true;
    }
  } catch { /* fall through to plain text */ }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

export async function openShareSheet() {
  if (overlay) return;
  let autoBooks = cache.autoBookings;
  if (!Array.isArray(autoBooks)) {
    try { autoBooks = await api.getAutoBookings(); } catch { autoBooks = []; }
  }
  const items = buildShareItems({ bookings: cache.bookings || [], waitlists: cache.waitlists || [], autoBooks });
  // Only gyms with something upcoming to share, in linked-gym order.
  const upcoming = new Set(gymsWithUpcoming(items));
  const linked = getLinkedGyms().map((g) => String(g.gym_id || g.id)).filter((id) => upcoming.has(id));
  const name = pickFirstName([...Object.values(cache.profilesByGym || {}), cache.profile]);
  const canNativeShare = typeof navigator.share === 'function';
  const state = { windowId: loadWindow(), gyms: new Set(linked), includeTbc: true };

  overlay = document.createElement('div');
  overlay.className = 'fr-sheet-overlay';
  overlay.innerHTML = `<div class="fr-sheet share-sheet" role="dialog" aria-modal="true" aria-label="${COPY.share.title}"></div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeShareSheet(); });
  document.body.appendChild(overlay);
  layer = pushLayer({ id: 'share-sheet', lock: true, escCloses: true, onBack: () => { layer = null; closeShareSheet(); } });
  void overlay.offsetWidth;
  overlay.classList.add('open');
  const sheet = overlay.querySelector('.fr-sheet');

  const compute = () => {
    const picked = filterShareItems(items, { windowId: state.windowId, gymIds: [...state.gyms], includeTbc: state.includeTbc });
    const counts = countShareItems(picked);
    const doc = formatShare(picked, { name, windowId: state.windowId, appName: appConfig.appName });
    return { picked, counts, text: doc.text, html: doc.html };
  };
  const countLabel = ({ total, tbc }) => {
    if (!total) return COPY.share.countNone;
    const base = total === 1 ? COPY.share.countOne : formatCopyText(COPY.share.count, { n: total });
    return tbc ? formatCopyText(COPY.share.withTbc, { base, tbc }) : base;
  };

  const paint = () => {
    const { counts, html } = compute();
    const empty = counts.total === 0;
    sheet.innerHTML = `
      <div class="fr-grab" aria-hidden="true"></div>
      <div class="fr-head">
        <div class="fr-title">${COPY.share.title}</div><span class="fr-badge" aria-live="polite">${escapeHtml(countLabel(counts))}</span>
        <button type="button" class="fr-close" data-share-close="1" aria-label="${COPY.share.close}">&#x2715;</button>
      </div>
      <div class="fr-body">
        <div class="fr-sec fr-sec-plain share-sec">
          <div class="share-label">${COPY.share.window}</div>
          <div class="fr-pills" role="group" aria-label="${COPY.share.window}">${SHARE_WINDOWS.map((w) =>
            `<button type="button" class="fr-pill${w.id === state.windowId ? ' on' : ''}" data-share-window="${w.id}" aria-pressed="${w.id === state.windowId}">${w.label}</button>`).join('')}</div>
        </div>
        ${linked.length > 1 ? `<div class="fr-sec fr-sec-plain share-sec">
          <div class="share-label">${COPY.share.gyms}</div>
          <div class="fr-gymrows">${linked.map((id) => {
            const on = state.gyms.has(id);
            return `<button type="button" class="fr-gymrow${on ? ' on' : ''}" data-share-gym="${escapeHtml(id)}" aria-pressed="${on}">${gymPlate(id)}</button>`;
          }).join('')}</div></div>` : ''}
        <label class="fr-sec fr-sec-plain share-sec share-tbc"><input type="checkbox" data-share-tbc="1"${state.includeTbc ? ' checked' : ''}><span>${COPY.share.includeTbc}</span></label>
        <div class="share-preview"><div class="share-label">${COPY.share.preview}</div><div class="share-preview-box">${empty ? `<p>${escapeHtml(COPY.share.countNone)}</p>` : html}</div></div>
      </div>
      <div class="share-foot">
        <div class="share-cta${canNativeShare ? '' : ' is-single'}">
          <button type="button" class="fr-save" data-share-copy="1"${empty ? ' disabled' : ''}>${COPY.share.copy}</button>
          ${canNativeShare ? `<button type="button" class="fr-done" data-share-native="1"${empty ? ' disabled' : ''}>${COPY.share.share}</button>` : ''}
        </div>
        <button type="button" class="share-cancel" data-share-close="1">${COPY.share.cancel}</button>
      </div>`;
    wireDragToDismiss(sheet, closeShareSheet);
  };

  sheet.addEventListener('change', (e) => {
    if (e.target.dataset.shareTbc) { state.includeTbc = e.target.checked; paint(); }
  });
  sheet.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.shareClose) return closeShareSheet();
    if (t.dataset.shareWindow) { state.windowId = t.dataset.shareWindow; saveWindow(state.windowId); return paint(); }
    if (t.dataset.shareGym) {
      const id = t.dataset.shareGym;
      if (!state.gyms.delete(id)) state.gyms.add(id);
      return paint();
    }
    if (t.dataset.shareCopy) {
      const ok = await copyText(compute());
      if (!ok) return showToast(COPY.share.copyFailed, 'error');
      showToast(COPY.share.copied, 'success');
      return closeShareSheet();
    }
    if (t.dataset.shareNative) {
      try {
        await navigator.share({ text: compute().text });
        closeShareSheet();   // resolved = the user picked a target; delivery itself is not observable
      } catch (err) {
        // Dismissing the native sheet is not a failure: keep the drawer open.
        if (err && err.name !== 'AbortError') showToast(COPY.share.shareFailed, 'error');
      }
    }
  });
  paint();
}
