// Safe-area-as-content (iOS 26+ installed PWA, status-bar-style black-translucent).
// In that mode the page reaches the top screen edge and env(safe-area-inset-top) > 0, so styles.css draws
// its own status-bar band. `html.sa-cover` turns those rules on. Everything else (Safari tabs, desktop,
// installs made with the `default` style, and builds hit by WebKit bug 301994 where the inset reads 0)
// leaves the class off and keeps the previous look.

export function shouldCover({ standalone, inset }) {
  return !!standalone && Number.isFinite(inset) && inset > 0;
}

export function initSafeArea(win = window, doc = document) {
  const root = doc.documentElement;
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
  const standalone = () => win.navigator.standalone === true || (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches);
  const update = () => {
    if (!probe.isConnected) root.appendChild(probe);
    const on = shouldCover({ standalone: standalone(), inset: probe.getBoundingClientRect().height });
    root.classList.toggle('sa-cover', on);
  };
  update();
  // The first frame can read 0 before the inset settles (measured on iOS 27): re-check.
  win.requestAnimationFrame && win.requestAnimationFrame(() => win.requestAnimationFrame(update));
  win.addEventListener('resize', update);
  win.addEventListener('orientationchange', update);
  return update;
}
