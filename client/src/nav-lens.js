// Liquid Glass nav: positions the selection "lens" behind the active bottom-nav tab.
// CSS only shows it under html.nav-glass; here we just publish --lens-x / --lens-w (transform + width animate).
export function initNavLens() {
  const nav = document.querySelector('.app-bottom-nav');
  const lens = nav && nav.querySelector('.app-nav-lens');
  if (!nav || !lens) return;
  let first = true;
  const place = () => {
    const btn = nav.querySelector('.app-bottom-nav-btn.active');
    if (!btn || !btn.offsetWidth) { nav.style.setProperty('--lens-o', '0'); return; }
    if (first) { // no slide from 0 on the first placement
      lens.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { lens.style.transition = ''; }));
      first = false;
    }
    nav.style.setProperty('--lens-x', `${btn.offsetLeft}px`);
    nav.style.setProperty('--lens-w', `${btn.offsetWidth}px`);
    nav.style.setProperty('--lens-o', '1');
  };
  new MutationObserver(place).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(place).observe(nav);
  window.addEventListener('resize', place, { passive: true });
  place();
}
