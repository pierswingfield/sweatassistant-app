// The ONLY module that writes browser history (pushState / replaceState / back / go) and the only
// popstate consumer. It owns the back stack described in nav-stack.js:
//   flat  (iOS standalone): history never grows; Back is applied straight to the stack, so the
//         system edge swipe has nothing to do and our own gesture (ui/edge-swipe-back.js) is the
//         only back.
//   sync  (browser tab, Android, desktop): one history entry per stack level, so the browser /
//         OS back pops exactly one level of what the app shows. A tab switch re-bases history.
// modal-nav pages and layers, Settings panes, Team pages and Auto-Book are all entries here.
import { parseLocation, serializeState } from './url-state.js';
import { stackFromRoute, planRoute, padTo, stateFor } from './nav-stack.js';

const MQ = '(max-width: 768px)';
const GO_TIMEOUT_MS = 500;
const MODE_KEY = 'appNavMode';

export function isMobileViewport() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(MQ).matches;
}

/** 'flat' in an iOS standalone PWA, 'sync' everywhere else. `?navmode=flat|sync` overrides (kept for the session). */
export function detectMode() {
  try {
    const q = new URLSearchParams(location.search).get('navmode');
    if (q === 'flat' || q === 'sync') { try { sessionStorage.setItem(MODE_KEY, q); } catch (_) { /* blocked */ } return q; }
    const saved = sessionStorage.getItem(MODE_KEY);
    if (saved === 'flat' || saved === 'sync') return saved;
  } catch (_) { /* no location/storage */ }
  try {
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true || (ios && typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
    return standalone ? 'flat' : 'sync';
  } catch (_) { return 'sync'; }
}

const curUrl = () => location.pathname + location.search;
const curRoute = () => parseLocation(location.pathname, location.search);

export function createNav({ mode: forcedMode = null } = {}) {
  let mode = forcedMode || detectMode();
  let entries = [];
  let booted = false;
  let routeHandler = null;
  let pendingPops = 0;
  let popCtx = null;       // ctx for the next self-issued pop
  let waiter = null;       // resolver for a rebase go()
  let inflight = null;     // promise of a self-issued back() until its popstate is processed
  let tail = null;
  let seq = 0;
  let listening = false;

  const sync = () => mode === 'sync';
  const homeFirst = () => mode === 'sync';

  // ── raw history writes (the only ones in the app) ───────────────────────────
  function writePush(e, depth, extra = null, url = null) {
    try { history.pushState(stateFor(e, depth, extra), '', url || e.url || curUrl()); } catch (_) { /* sandboxed */ }
  }
  function writeReplace(e, depth, extra = null, url = null) {
    try { history.replaceState(stateFor(e, depth, { ...(history.state || {}), ...(extra || {}) }), '', url || e.url || curUrl()); } catch (_) { /* sandboxed */ }
  }

  function ensureBooted() {
    if (booted) return;
    booted = true;
    entries = stackFromRoute(curRoute(), { mobile: isMobileViewport(), homeFirst: homeFirst(), url: curUrl() });
  }

  function teardown(list) {
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (e.kind === 'route' || e.dead) continue;
      e.dead = true;
      try { e.onPop?.({ force: true, instant: true, reason: 'route' }); } catch (err) { console.error('[nav] onPop failed', err); }
    }
  }

  function goBack(n) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(t); waiter = null; resolve(); };
      const t = setTimeout(finish, GO_TIMEOUT_MS);
      waiter = finish;
      try { history.go(-n); } catch (_) { finish(); }
    });
  }

  function enqueue(fn) {
    const exec = () => (inflight ? inflight.then(fn) : fn());
    const track = (r) => {
      const t = Promise.resolve(r).catch((err) => console.error('[nav]', err)).then(() => { if (tail === t) tail = null; });
      tail = t;
      return t;
    };
    if (!tail) {
      let r;
      try { r = exec(); } catch (err) { console.error('[nav]', err); return undefined; }
      if (r && typeof r.then === 'function') return track(r);
      return r;
    }
    return track(tail.then(exec));
  }

  function notifyRoute() { try { routeHandler?.(curRoute()); } catch (err) { console.error('[nav] route handler failed', err); } }

  // Pop entries (no guards here) down to `target`, running page/layer callbacks, then tell the router.
  function popTo(target, ctx = {}) {
    let routePopped = false;
    while (entries.length - 1 > target && entries.length > 1) {
      const e = entries.pop();
      if (e.kind === 'route') routePopped = true;
      else if (!e.dead) { e.dead = true; try { e.onPop?.(ctx); } catch (err) { console.error('[nav] onPop failed', err); } }
    }
    const top = entries[entries.length - 1];
    if (routePopped && top && top.kind === 'route') {
      if (!sync()) writeReplace(top, entries.length - 1);
      notifyRoute();
    }
  }

  async function guardOk(e) {
    if (!e.canClose || e.dead) return true;
    try { return (await e.canClose()) !== false; } catch (_) { return true; }
  }

  // ── boot ───────────────────────────────────────────────────────────────────
  /** Make the stack and history agree with the URL. Call once before the first paint. */
  function boot() {
    booted = true;
    const target = stackFromRoute(curRoute(), { mobile: isMobileViewport(), homeFirst: homeFirst(), url: curUrl() });
    const top = target.length - 1;
    if (!sync()) { entries = target; writeReplace(target[top], top); return undefined; }
    const st = history.state;
    const d0 = typeof st?.appNavDepth === 'number' ? st.appNavDepth : null;
    if (d0 !== null && d0 === top) { entries = target; return undefined; } // reload of a consistent entry
    if (d0 !== null && d0 > top) {
      if (st.appNavKind && st.appNavKind !== 'route') {
        // Reloaded with an overlay open: its in-memory page is gone, step back onto the route level.
        entries = target;
        return goBack(d0 - top).then(() => { writeReplace(target[top], top, null, curUrl()); notifyRoute(); });
      }
      entries = padTo(target, d0); // extra route-level states (timetable filter steps) survive a reload
      return undefined;
    }
    entries = target;
    writeReplace(target[0], 0, null, target[0].url);
    for (let i = 1; i < target.length; i++) writePush(target[i], i);
    return undefined;
  }

  // ── routes ─────────────────────────────────────────────────────────────────
  /**
   * Show `route` (parsed route object). Settles the stack to that route's parent chain: pushes when it
   * is a drill-down of the current one, otherwise re-bases (pops what is not shared). Open pages and
   * layers above the shared part are closed. `url` carries the query; `replace` swaps the top level.
   */
  function routeTo(route, { url = null, replace = false, extra = null } = {}) {
    ensureBooted();
    const target = stackFromRoute(route, { mobile: isMobileViewport(), homeFirst: homeFirst(), url });
    const plan = planRoute(entries, target, { replace });
    if (plan.urlOnly) {
      entries[entries.length - 1] = { ...entries[entries.length - 1], url: target[target.length - 1].url };
      writeReplace(entries[entries.length - 1], entries.length - 1, extra);
      return undefined;
    }
    teardown(plan.drop);
    if (!sync()) {
      entries = target;
      writeReplace(target[target.length - 1], target.length - 1, extra);
      return undefined;
    }
    return enqueue(async () => {
      const kept = entries.slice(0, plan.keep);
      entries = kept;
      if (plan.goBack > 0) await goBack(plan.goBack);
      if (plan.replaceAt === null && plan.pushes.length === 0) {
        // pure pop: the landing entry may carry a stale URL
        const last = target[target.length - 1];
        entries = target.slice();
        writeReplace(last, target.length - 1, extra, last.url);
        return;
      }
      let i = plan.keep;
      if (plan.replaceAt !== null) {
        entries.push(target[i]);
        writeReplace(target[i], i, plan.pushes.length ? null : extra, target[i].url);
        i++;
      }
      for (const e of plan.pushes) {
        entries.push(e);
        writePush(e, i, i === target.length - 1 ? extra : null);
        i++;
      }
    });
  }

  /** Same as routeTo for a URL string (path + query). */
  function routeToUrl(url, opts = {}) {
    let u;
    try { u = new URL(url, location.origin); } catch (_) { return false; }
    const route = parseLocation(u.pathname, u.search);
    if (!route.valid) return false;
    routeTo(route, { ...opts, url: u.pathname + u.search });
    return true;
  }

  /** Push one drill-down route level (Settings pane, ...) on top of the current stack. */
  function pushRoute({ key, url = null, extra = null }) {
    ensureBooted();
    const top = entries[entries.length - 1];
    if (top && top.key === key) { replaceUrl(url, extra); return undefined; }
    return enqueue(() => {
      const e = { kind: 'route', key: key || `r${++seq}`, url: url || curUrl() };
      entries.push(e);
      if (sync()) writePush(e, entries.length - 1, extra, e.url);
      else writeReplace(e, entries.length - 1, extra, e.url);
    });
  }

  /** Rewrite the top level's URL without adding an entry. */
  function replaceUrl(url = null, extra = null) {
    ensureBooted();
    const i = entries.length - 1;
    if (url && entries[i]) entries[i] = { ...entries[i], url };
    writeReplace(entries[i], i, extra, url);
  }

  // ── pages / layers (modal-nav) ─────────────────────────────────────────────
  /** entry: { kind:'page'|'layer', key, canClose?(), onPop?(ctx) }. */
  function push(entry) {
    ensureBooted();
    const e = { ...entry };
    const run = () => {
      entries.push(e);
      if (sync()) writePush(e, entries.length - 1, null, curUrl());
    };
    // Return the live record so callers can flag skipGuard / dead on it.
    if (tail) enqueue(run); else run();
    return e;
  }

  /** Swap a finished page for its successor in the same slot (no history growth). */
  function replaceEntry(oldRec, newRec) {
    const i = entries.indexOf(oldRec);
    if (i === -1) return false;
    oldRec.dead = true;
    entries[i] = newRec;
    if (sync() && i === entries.length - 1) writeReplace(newRec, i, null, curUrl());
    return true;
  }

  /** Programmatic removal of one entry (no guard). */
  function remove(rec) {
    const i = entries.indexOf(rec);
    if (i === -1) return false;
    if (i === entries.length - 1) { back({ force: true }); return true; }
    rec.dead = true; // buried under newer levels: its history slot stays, it just goes quiet
    if (!sync()) entries.splice(i, 1);
    return true;
  }

  // ── back ───────────────────────────────────────────────────────────────────
  /** Close one level. Resolves false when there is nothing to go back to or a guard refused. */
  async function back({ force = false, instant = false, source = 'button' } = {}) {
    ensureBooted();
    if (entries.length < 2) return false;
    const top = entries[entries.length - 1];
    if (!force && top.kind !== 'route' && !(await guardOk(top))) return false;
    const ctx = { source, instant, force };
    return enqueue(() => {
      if (entries.length < 2) return false;
      const t = entries[entries.length - 1];
      if (!sync()) {
        // Same task ordering as a real popstate: callers run their follow-up code first.
        setTimeout(() => popTo(entries.length - 2, ctx), 0);
        return true;
      }
      if (history.state?.appNavDepth === entries.length - 1) {
        pendingPops++;
        t.skipGuard = true;
        popCtx = ctx;
        let release;
        inflight = new Promise((res) => { release = res; });
        const clear = () => { if (inflight) { inflight = null; release(); } };
        inflight.clear = clear;
        setTimeout(clear, GO_TIMEOUT_MS);
        history.back();
      } else {
        popTo(entries.length - 2, ctx);
      }
      return true;
    });
  }

  // ── popstate ───────────────────────────────────────────────────────────────
  async function onPopState(e) {
    e.appNavHandled = true;
    if (waiter) { waiter(); return; }
    ensureBooted();
    const own = pendingPops > 0;
    if (own) pendingPops--;
    const ctx = own && popCtx ? popCtx : { source: 'system', instant: false, force: false };
    if (own) popCtx = null;
    try {
      await handlePop(ctx);
    } finally {
      if (inflight) inflight.clear?.();
    }
  }

  async function handlePop(ctx) {
    if (!sync()) { resync(); return; }
    const st = history.state;
    let target = typeof st?.appNavDepth === 'number' ? st.appNavDepth : null;
    const d = entries.length - 1;
    if (target === null) {
      const firstOverlay = entries.findIndex((x) => x.kind !== 'route');
      target = firstOverlay > 0 ? firstOverlay - 1 : null;
    }
    if (target === null) { resync(); return; }
    if (target < d) {
      let routePopped = false;
      for (let i = d; i > target; i--) {
        const top = entries[i];
        if (!top) continue;
        if (top.kind !== 'route' && !top.skipGuard && !(await guardOk(top))) {
          // Refused: put the history entries back so the page stays open.
          for (let j = target + 1; j <= i; j++) writePush(entries[j], j, null, entries[j].kind === 'route' ? entries[j].url : curUrl());
          if (routePopped) notifyRoute();
          return;
        }
        const e = entries.pop();
        if (e.kind === 'route') routePopped = true;
        else if (!e.dead) { e.dead = true; try { e.onPop?.(ctx); } catch (err) { console.error('[nav] onPop failed', err); } }
      }
      if (routePopped) notifyRoute();
      return;
    }
    if (target > d) {
      if (st?.appNavKind && st.appNavKind !== 'route') { pendingPops++; popCtx = { instant: true, source: 'system' }; history.back(); return; } // cannot rebuild an overlay
      const rebuilt = padTo(stackFromRoute(curRoute(), { mobile: isMobileViewport(), homeFirst: true, url: curUrl() }), target);
      entries = rebuilt;
      writeReplace(rebuilt[rebuilt.length - 1], rebuilt.length - 1, null, curUrl());
      notifyRoute();
      return;
    }
    notifyRoute(); // same depth: another route entry at this level (e.g. a timetable step)
  }

  // A history entry we do not recognise (notification click, flat-mode stray): rebuild from the URL.
  function resync() {
    teardown(entries);
    entries = stackFromRoute(curRoute(), { mobile: isMobileViewport(), homeFirst: homeFirst(), url: curUrl() });
    writeReplace(entries[entries.length - 1], entries.length - 1, null, curUrl());
    notifyRoute();
  }

  function listen() {
    if (listening || typeof window === 'undefined') return;
    listening = true;
    window.addEventListener('popstate', onPopState, true);
  }
  listen();

  return {
    get mode() { return mode; },
    setMode(m) { mode = m; },
    boot, routeTo, routeToUrl, pushRoute, replaceUrl, push, replaceEntry, remove, back,
    canGoBack() { ensureBooted(); return entries.length > 1; },
    depth() { ensureBooted(); return entries.length - 1; },
    top() { ensureBooted(); return entries[entries.length - 1] || null; },
    entries() { return entries.slice(); },
    nextSeq() { return ++seq; },
    idle() { return tail || Promise.resolve(); },
    setRouteHandler(fn) { routeHandler = fn; },
    pathFor: (state) => serializeState(state),
    _reset() {
      entries = []; booted = false; pendingPops = 0; popCtx = null; waiter = null; inflight = null; tail = null; seq = 0;
      mode = forcedMode || detectMode();
    },
    _dispose() { window.removeEventListener('popstate', onPopState, true); listening = false; },
  };
}

export const nav = createNav();
