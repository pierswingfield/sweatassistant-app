// iOS standalone PWAs can leave a stale WINDOW scroll after a rotation (observed: scrollY 62,
// visualViewport.offsetTop 62). The app shell is position:fixed, so the paint stays put while
// hit-testing shifts by that scroll, and taps land below the visible element. The document never
// legitimately scrolls (the shell scrolls inside main.app-body), so any non-zero window scroll is stale.
export function resetWindowScroll() {
  try {
    const se = document.scrollingElement;
    if (window.scrollY || window.scrollX || (se && se.scrollTop)) window.scrollTo(0, 0);
  } catch (e) { /* jsdom */ }
}

function inputFocused() {
  const a = document.activeElement;
  return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
}

export function installStaleScrollGuard() {
  const run = () => {
    if (inputFocused()) return; // keyboard open: do not fight iOS's own reveal-scroll
    resetWindowScroll();
    requestAnimationFrame(resetWindowScroll);
    setTimeout(() => { if (!inputFocused()) resetWindowScroll(); }, 300); // orientation settles late
  };
  window.addEventListener('orientationchange', run);
  window.addEventListener('resize', run);
  window.visualViewport?.addEventListener('resize', run);
  window.visualViewport?.addEventListener('scroll', run);
}
