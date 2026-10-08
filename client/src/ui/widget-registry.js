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

/**
 * Run ONE widget into `el`, going loading -> (render | empty | error). Safe to call
 * again (that is the retry). A newer run supersedes an older one still in flight.
 */
export async function mountWidget(el, widget, ctx, { skeleton = () => '', copy = {} } = {}) {
  const token = (el._wRun = (el._wRun || 0) + 1);
  const live = () => el._wRun === token;
  const body = () => el.querySelector('[data-widget-body]');
  el.dataset.widgetState = 'loading';
  el.innerHTML = `<h4 class="home-widget-title">${esc(widget.title)}</h4><div data-widget-body>${skeleton(widget)}</div>`;
  try {
    const data = typeof widget.load === 'function' ? await widget.load(ctx) : null;
    if (!live()) return;
    const b = body();
    if (widget.isEmpty && widget.isEmpty(data, ctx)) {
      el.dataset.widgetState = 'empty';
      if (typeof widget.renderEmpty === 'function') {
        b.innerHTML = '';
        widget.renderEmpty(b, data, ctx);
      } else {
        b.innerHTML = `<p class="home-widget-empty">${esc(widget.emptyText || copy.empty || '')}</p>`;
      }
      return;
    }
    el.dataset.widgetState = 'ready';
    b.innerHTML = '';
    widget.render(b, data, ctx);
  } catch (err) {
    if (!live()) return;
    el.dataset.widgetState = 'error';
    const b = body();
    if (isNoGymError(err)) {
      b.innerHTML = `<p class="home-widget-empty">${esc(copy.noGym || '')}</p>`;
      return;
    }
    b.innerHTML = `<p class="home-widget-error" role="alert">${esc(copy.error || '')}</p><button type="button" class="home-widget-retry">${esc(copy.retry || 'Retry')}</button>`;
    b.querySelector('.home-widget-retry').addEventListener('click', () => mountWidget(el, widget, ctx, { skeleton, copy }));
  }
}
