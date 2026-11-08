// Edge state belongs to the content scrollport, never its adjacent action rail.
export function scrollEdges({ scrollWidth, clientWidth, scrollLeft = 0, rtl = false }) {
  const overflow = scrollWidth > clientWidth + 1;
  const left = rtl ? Math.max(0, scrollWidth - clientWidth + scrollLeft) : Math.max(0, scrollLeft);
  return { left: overflow && left > 1, right: overflow && left + clientWidth < scrollWidth - 1 };
}

export function observeEdgeFades(root = document.body) {
  const selector = '.app-edge-fade, .tm-attendees, .tm-stats-carousel, .fr-track, .app-wk-scroller, .ab-chip-group';
  const tracked = new Map();
  let frame;
  const update = (el) => {
    const edges = scrollEdges({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: el.scrollLeft, rtl: getComputedStyle(el).direction === 'rtl' });
    el.classList.toggle('has-edge-fade', edges.left || edges.right);
    el.classList.toggle('fade-left', edges.left);
    el.classList.toggle('fade-right', edges.right);
  };
  const resize = new ResizeObserver((entries) => entries.forEach(({ target }) => update(target)));
  const scan = () => {
    frame = null;
    for (const [el, handler] of tracked) if (!root.contains(el)) { el.removeEventListener('scroll', handler); resize.unobserve(el); tracked.delete(el); }
    root.querySelectorAll(selector).forEach((el) => {
      if (!tracked.has(el)) { const handler = () => update(el); tracked.set(el, handler); el.addEventListener('scroll', handler, { passive: true }); resize.observe(el); }
      update(el);
    });
  };
  const mutation = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(scan); });
  mutation.observe(root, { childList: true, subtree: true, characterData: true });
  scan();
  return () => { mutation.disconnect(); resize.disconnect(); if (frame) cancelAnimationFrame(frame); for (const [el, handler] of tracked) el.removeEventListener('scroll', handler); tracked.clear(); };
}
