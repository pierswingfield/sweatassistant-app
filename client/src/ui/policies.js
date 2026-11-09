import { escapeHtml } from './cards.js';
import { openPage, closePage } from './modal-nav.js';
// Keep the account/gym form mounted while reading, including its checkbox state.
export function initPolicyLinks() {
  document.addEventListener('click', async (event) => {
    const link = event.target.closest('a[data-policy-link]');
    if (!link) return;
    const url = new URL(link.href, location.origin);
    if (url.origin !== location.origin || !/^\/policies\/(terms|privacy)\.html$/.test(url.pathname)) return;
    event.preventDefault();
    const modal = document.createElement('div');
    modal.className = 'app-modal app-policy-modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', link.textContent);
    modal.innerHTML = `<div class="app-modal-content"><header class="app-modal-header"><h2>${escapeHtml(link.textContent)}</h2><button type="button" class="app-btn" aria-label="Close policy">Back</button></header><article tabindex="0" aria-label="Policy document">Loading…</article></div>`;
    document.body.append(modal);
    const close = () => { if (!closePage(modal)) { modal.remove(); link.focus(); } };
    const button = modal.querySelector('button');
    button.onclick = close;
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); close(); } });
    modal.style.display = 'none';
    openPage(modal, { id: `policy-${url.pathname}`, remove: true });
    button.focus();
    try {
      const response = await fetch(url.pathname);
      if (!response.ok) throw new Error('Could not load policy. Please try again.');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      // Only our published, same-origin policy document; never provider/user HTML.
      const main = doc.querySelector('main');
      if (!main) throw new Error('Policy unavailable. Please try again.');
      modal.querySelector('article').replaceChildren(...main.childNodes);
    } catch (err) { modal.querySelector('article').textContent = err.message; }
  });
}
