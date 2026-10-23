// Tiny widget framework for the Home page (F-10-1).
//
//   registerWidget({ id, title, order, load(ctx), render(el, data, ctx), isVisible?(ctx), isEmpty?(data, ctx), emptyText?, renderEmpty?(el, data, ctx) })
//
// Every widget loads, renders and fails independently: one rejection never reaches
// a sibling. Pure registry + a small DOM mounter with loading / empty / error(retry).

export function createRegistry() {
  const widgets = new Map();
  return {
    register(def) {
      if (!def || !def.id || typeof def.render !== 'function') throw new Error('widget needs an id and a render()');
      widgets.set(def.id, { order: 100, load: async () => null, ...def });
    },
    /** Visible widgets in display order (order, then id for a stable tie-break). */
    list(ctx = {}) {
      return [...widgets.values()]
        .filter((w) => { try { return typeof w.isVisible === 'function' ? w.isVisible(ctx) !== false : true; } catch (_) { return false; } })
        .sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
    },
    clear() { widgets.clear(); },
  };
}

export const registry = createRegistry();
export const registerWidget = (def) => registry.register(def);

/** Load every widget concurrently; a failing one yields {status:'rejected'} and nothing else changes. */
export async function loadWidgets(widgets, ctx) {
  const settled = await Promise.allSettled(widgets.map((w) => Promise.resolve().then(() => w.load(ctx))));
  return settled.map((r, i) => ({ widget: widgets[i], ...r }));
}

export function isNoGymError(err) {
  return !!err && (err.code === 'NO_GYM_LINKED' || err.status === 409);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Home refreshes on foregrounding and on successful stale-cache writes. Keep a
// widget's already-mounted controls when those refreshes resolve to the same
// value: replacing the body needlessly drops focus and DevTools node identity.
function dataSignature(widget, data, ctx) {
  try {
    const value = typeof widget.dataSignature === 'function'
      ? widget.dataSignature(data, ctx)
      : data;
    return JSON.stringify(value);
  } catch (_) {
    // A widget may opt into a richer value later; in that case, safely repaint
    // instead of treating an unserialisable result as unchanged.
    return null;
  }
}

/**
 * Run ONE widget into `el`, going loading -> (render | empty | error). Safe to call
 * again (that is the retry). A newer run supersedes an older one still in flight.
 */
export async function mountWidget(el, widget, ctx, { skeleton = () => '', copy = {}, hasCachedData = null, contextKey = '' } = {}) {
  const token = (el._wRun = (el._wRun || 0) + 1);
  const live = () => el._wRun === token;
  const body = () => el.querySelector('[data-widget-body]');
  const heading = () => el.querySelector('.home-widget-title');
  const titleFor = (data) => typeof widget.title === 'function' ? widget.title(data, ctx) : widget.title;
  const canKeepContent = !!contextKey && el.dataset.widgetContextKey === contextKey && el.dataset.widgetHasContent === 'true';
  el.dataset.widgetContextKey = contextKey;
  el.dataset.widgetState = canKeepContent ? 'refreshing' : 'loading';
  if (!canKeepContent) {
    let cached = false;
    if (typeof hasCachedData === 'function') {
      try { cached = !!(await hasCachedData(widget, ctx)); } catch (_) { /* cache is best-effort */ }
      if (!live()) return;
    }
    el.innerHTML = `<div class="home-widget-heading"><h3 class="home-widget-title">${esc(titleFor(undefined))}</h3><span class="home-widget-meta" data-widget-meta></span><span data-widget-action></span></div><div data-widget-body>${cached ? '' : skeleton(widget)}</div>`;
    if (typeof widget.headerAction === 'function') {
      const action = widget.headerAction(ctx);
      if (action) el.querySelector('[data-widget-action]')?.append(action);
    }
  }
  try {
    const data = typeof widget.load === 'function' ? await widget.load(ctx) : null;
    if (!live()) return;
    const title = heading();
    if (title) title.textContent = titleFor(data);
    const actionSlot = el.querySelector('[data-widget-action]');
    if (actionSlot && typeof widget.updateHeaderAction === 'function') {
      widget.updateHeaderAction(actionSlot, ctx, data);
    }
    const meta = el.querySelector('[data-widget-meta]');
    if (meta && typeof widget.headerMeta === 'function') meta.textContent = widget.headerMeta(data, ctx) || '';
    const b = body();
    const empty = !!(widget.isEmpty && widget.isEmpty(data, ctx));
    const outcome = empty ? 'empty' : 'ready';
    const signature = dataSignature(widget, data, ctx);
    const unchanged = canKeepContent
      && signature !== null
      && el._wOutcome === outcome
      && el._wDataSignature === signature;
    if (unchanged) {
      el.dataset.widgetState = outcome;
      el.dataset.widgetStale = 'false';
      return;
    }
    if (empty) {
      el.dataset.widgetState = 'empty';
      if (typeof widget.renderEmpty === 'function') {
        b.innerHTML = '';
        widget.renderEmpty(b, data, ctx);
      } else {
        b.innerHTML = `<p class="home-widget-empty">${esc(widget.emptyText || copy.empty || '')}</p>`;
      }
      el.dataset.widgetHasContent = 'true';
      el.dataset.widgetStale = 'false';
      el._wOutcome = outcome;
      el._wDataSignature = signature;
      return;
    }
    el.dataset.widgetState = 'ready';
    b.innerHTML = '';
    widget.render(b, data, ctx);
    el.dataset.widgetHasContent = 'true';
    el.dataset.widgetStale = 'false';
    el._wOutcome = outcome;
    el._wDataSignature = signature;
  } catch (err) {
    if (!live()) return;
    if (canKeepContent) {
      // A failed refresh does not evict the last successful Home view.
      el.dataset.widgetState = 'stale';
      el.dataset.widgetStale = 'true';
      return;
    }
    el.dataset.widgetState = 'error';
    const b = body();
    if (isNoGymError(err)) {
      b.innerHTML = `<p class="home-widget-empty">${esc(copy.noGym || '')}</p>`;
      return;
    }
    b.innerHTML = `<p class="home-widget-error" role="alert">${esc(copy.error || '')}</p><button type="button" class="home-widget-retry">${esc(copy.retry || 'Retry')}</button>`;
    b.querySelector('.home-widget-retry').addEventListener('click', () => mountWidget(el, widget, ctx, { skeleton, copy, hasCachedData, contextKey }));
  }
}
