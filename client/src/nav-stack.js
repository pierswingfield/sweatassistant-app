// Pure back-navigation model (no DOM, no history). See Documentation/DESIGN.md "Back navigation".
//
// ONE linear stack of entries describes where "Back" goes. Every entry is a LEVEL:
//   kind 'route'  a screen the URL can rebuild (tab root, Settings pane, Team page, Auto-Book...)
//   kind 'page'   a modal-nav full-screen overlay (not rebuildable from a URL)
//   kind 'layer'  a modal-nav dialog / sheet (not rebuildable)
// In `sync` mode (browser tab, Android, desktop) the browser history mirrors this stack one entry
// per level; in `flat` mode (iOS standalone) history never grows and the stack is the only truth.
import { serializeState, TAB_TO_PATH } from './url-state.js';

export const HOME_KEY = 'home';

function tabKey(tab) { return tab === 'home' ? HOME_KEY : `tab:${tab}`; }
function entry(key, url) { return { kind: 'route', key, url }; }

/**
 * Parent chain for a parsed route ({tab, section, teams, valid}), root first, as route entries.
 *  - `mobile`: Settings panes and Auto-Book are drill-downs (a parent level exists); on desktop the
 *    Settings panes are side by side and Auto-Book is its own tab, so neither adds a level.
 *  - `homeFirst`: a non-Home tab root sits on top of Home (Back at a tab root goes Home first).
 *  - `url`: the full current URL (query included) for the LAST entry; parents get clean paths.
 */
export function stackFromRoute(route, { mobile = true, homeFirst = false, url = null } = {}) {
  const r = route && route.valid !== false ? route : { tab: 'home' };
  const tab = r.tab || 'home';
  if (tab === 'about') return stackFromRoute({ tab: 'settings', section: 'about' }, { mobile, homeFirst, url });
  const out = [];
  if (homeFirst && tab !== 'home') out.push(entry(HOME_KEY, '/'));
  if (tab === 'home') {
    out.push(entry(HOME_KEY, '/'));
  } else if (tab === 'auto-book') {
    if (mobile) out.push(entry(tabKey('my-bookings'), TAB_TO_PATH['my-bookings']));
    out.push(entry(tabKey('auto-book'), TAB_TO_PATH['auto-book']));
  } else if (tab === 'settings') {
    out.push(entry(tabKey('settings'), '/settings'));
    const s = r.section;
    if (s && mobile) {
      if (String(s).startsWith('gym-')) out.push(entry('settings:gyms', '/settings/gyms'));
      out.push(entry(`settings:${s}`, serializeState({ tab: 'settings', section: s })));
    }
  } else if (tab === 'teams') {
    out.push(entry(tabKey('teams'), '/teams'));
    if (r.teams && r.teams.view === 'team' && r.teams.teamId) out.push(entry(`team:${r.teams.teamId}`, serializeState({ tab: 'teams', teams: r.teams })));
  } else {
    out.push(entry(tabKey(tab), TAB_TO_PATH[tab] || '/'));
  }
  if (url && out.length) out[out.length - 1] = { ...out[out.length - 1], url };
  return out;
}

/** Number of leading entries two stacks share, by key. */
export function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i].key === b[i].key) i++;
  return i;
}

/**
 * Plan the change from `current` to `target` (both arrays of entries).
 *   drop      current entries above the shared prefix (their pages/layers are torn down)
 *   goBack    history.go(-n) needed first (sync mode), 0 when none
 *   replaceAt index whose history entry is rewritten (after the go), or null
 *   pushes    target entries to push after that
 *   urlOnly   same route, only the URL may differ (query change) -> rewrite the top entry's URL
 * `replace` means the current top is being replaced (never kept as a prefix).
 */
export function planRoute(current, target, { replace = false } = {}) {
  const d = current.length - 1;
  let p = commonPrefix(current, target);
  if (replace && p > 0 && p >= current.length) p = current.length - 1;
  const plan = { keep: p, drop: current.slice(p), goBack: 0, replaceAt: null, pushes: [], urlOnly: false };
  if (p === current.length && p === target.length) { plan.urlOnly = true; return plan; }
  const fresh = target.slice(p);
  if (fresh.length === 0) {
    plan.goBack = d - (p - 1); // pure pop: land on index p-1
    return plan;
  }
  if (d >= p) {
    plan.goBack = d - p; // land on index p, then rewrite it
    plan.replaceAt = p;
    plan.pushes = fresh.slice(1);
  } else {
    plan.pushes = fresh; // d === p - 1: pure extension
  }
  return plan;
}

/** After a forward/foreign navigation: pad a rebuilt stack (duplicating its top) to `depth`. */
export function padTo(stack, depth) {
  const out = stack.slice();
  while (out.length - 1 < depth && out.length) out.push({ ...out[out.length - 1] });
  return out;
}

/** history.state payload for the entry at `depth`. */
export function stateFor(e, depth, extra = null) {
  return { ...(extra || {}), appNavDepth: depth, appNavId: e?.key || '', appNavKind: e?.kind || 'route' };
}

/** Should a left-edge drag commit? (distance fraction, or a flick). `velocity` is px/ms. */
export function shouldCommit(dx, velocity, width) {
  if (!(width > 0)) return false;
  if (dx / width > 0.35) return true;
  return velocity > 0.5 && dx > 30;
}

/** Direction classifier for the edge swipe: 'pending' | 'back' | 'abort'. */
export function classifyMove(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (ay > 10 && ay > ax) return 'abort';
  if (dx > 10 && dx > ay * 1.5) return 'back';
  if (dx < -10) return 'abort';
  return 'pending';
}
