// Shared header bar: [back] [title] [actions]. One renderer + one CSS block (.app-hbar in styles.css)
// for the Settings panes, Team page, Team class page and the mobile Auto-Book page.
// The title is centred on the SCREEN; when the back label (or the actions) is too wide for that, the
// title slides over just far enough to clear it and truncates with an ellipsis if still too long.
import { escapeHtml } from '../escape-html.js';

export const BACK_ARROW = '<svg class="app-hbar-arrow" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';

/**
 * Markup for a header bar. All text is escaped here; `actionsHtml` must already be safe markup.
 * `back`: { label, aria, href } (an <a> when href is given, else a <button>). `sticky` opts in to the
 * mobile pin-under-the-app-header behaviour.
 */
export function headerBarHtml({ back, title = '', actionsHtml = '', sticky = false, className = '', backAttrs = 'data-back', titleAttrs = '' } = {}) {
  const aria = back?.aria ? ` aria-label="${escapeHtml(back.aria)}"` : '';
  const inner = `${BACK_ARROW}<span class="app-hbar-back-txt">${escapeHtml(back?.label || '')}</span>`;
  const backEl = back
    ? (back.href ? `<a class="app-hbar-back" href="${escapeHtml(back.href)}" ${backAttrs}${aria}>${inner}</a>`
      : `<button type="button" class="app-hbar-back" ${backAttrs}${aria}>${inner}</button>`)
    : '<span class="app-hbar-back" aria-hidden="true"></span>';
  // An empty title renders no heading at all (the page's own hero carries the name): the middle column stays
  // as 1fr spacing, so the back button sits left and the actions right.
  const titleEl = title ? `<h1 class="app-hbar-title" ${titleAttrs}>${escapeHtml(title)}</h1>` : '';
  return `<div class="app-hbar${sticky ? ' app-hbar-sticky' : ''}${className ? ` ${escapeHtml(className)}` : ''}">${backEl}${titleEl}<div class="app-hbar-actions">${actionsHtml}</div></div>`;
}

/** An icon + text action for the bar (same size as the bar text). `iconHtml` is trusted SVG markup. */
export function headerActionHtml({ iconHtml = '', label, aria, attrs = '', badge = 0 }) {
  return `<button type="button" class="app-hbar-act" ${attrs}${aria ? ` aria-label="${escapeHtml(aria)}"` : ''}>${iconHtml}<span class="app-hbar-act-txt">${escapeHtml(label)}</span>${badge ? `<span class="tm-count app-hbar-badge" aria-hidden="true">${escapeHtml(String(badge))}</span>` : ''}</button>`;
}

/**
 * Pure placement maths. All values are x offsets/widths in the same unit, relative to the bar's left
 * edge. Returns the title's left offset inside the middle region [minX, maxX]: screen-centred when it
 * fits, otherwise clamped so it never overlaps the back button or actions.
 */
export function titleOffset({ barWidth, titleWidth, minX, maxX }) {
  const room = Math.max(0, maxX - minX);
  const w = Math.min(titleWidth, room);
  const ideal = (barWidth - w) / 2;
  const left = Math.min(Math.max(ideal, minX), Math.max(minX, maxX - w));
  return { left, width: w };
}

export const MIN_TITLE_ROOM = 64;

function layout(bar) {
  const back = bar.querySelector(':scope > .app-hbar-back');
  const title = bar.querySelector(':scope > .app-hbar-title');
  const acts = bar.querySelector(':scope > .app-hbar-actions');
  if (!title) { bar.classList.remove('hbar-squeezed'); return; } // titleless bar: nothing to centre
  bar.classList.add('js-hbar');
  const b = bar.getBoundingClientRect();
  if (!b.width) return; // hidden (desktop Settings bar etc.)
  const gap = 10;
  title.style.removeProperty('margin-left');
  const bw = back ? back.getBoundingClientRect() : null;
  const aw = acts && acts.children.length ? acts.getBoundingClientRect() : null;
  const minX = bw && bw.width ? bw.right - b.left + gap : 0;
  const maxX = aw && aw.width ? aw.left - b.left - gap : b.width;
  const tw = title.scrollWidth;
  const { left } = titleOffset({ barWidth: b.width, titleWidth: tw, minX, maxX });
  // Too little room to show even a recognisable fragment: hide the title rather than show "S…".
  bar.classList.toggle('hbar-squeezed', maxX - minX < MIN_TITLE_ROOM && tw > maxX - minX);
  const cur = title.getBoundingClientRect().left - b.left;
  const natural = cur; // margin removed above, so this is the column-start position
  title.style.marginLeft = `${Math.max(0, left - natural)}px`;
}

const seen = new WeakSet();
function attach(bar) {
  if (seen.has(bar)) return;
  seen.add(bar);
  const run = () => requestAnimationFrame(() => layout(bar));
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(run);
    ro.observe(bar);
    for (const el of bar.children) ro.observe(el);
  }
  if (typeof MutationObserver !== 'undefined') new MutationObserver(run).observe(bar, { childList: true, characterData: true, subtree: true });
  run();
}

/** Attach centring to every .app-hbar now and to any added later (re-rendered pages, modal pages). */
export function initHeaderBars(root = document) {
  if (typeof document === 'undefined') return;
  const scan = (n) => {
    if (n.nodeType !== 1) return;
    if (n.matches?.('.app-hbar')) attach(n);
    n.querySelectorAll?.('.app-hbar').forEach(attach);
  };
  scan(root.body || root);
  if (typeof MutationObserver !== 'undefined' && !initHeaderBars.mo) {
    initHeaderBars.mo = new MutationObserver((muts) => { for (const m of muts) m.addedNodes.forEach(scan); });
    initHeaderBars.mo.observe(document.body, { childList: true, subtree: true });
  }
}
