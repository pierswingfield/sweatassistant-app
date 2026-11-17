// Managed in-app toast stack. Every toast enters with a slide + fade, the stack reflows with a
// FLIP transform when one leaves, and a toast is only removed from the DOM after its exit
// transition ends (with a timeout fallback), never mid-animation. Timers are per toast.
// Visual states live in styles.css (`.app-toast`, `.show`, `.is-leaving`); this module owns timing.

export const TOAST_MAX_VISIBLE = 3;
export const TOAST_LEAVE_FALLBACK_MS = 420;

export function createToastStack(container, { max = TOAST_MAX_VISIBLE, leaveFallbackMs = TOAST_LEAVE_FALLBACK_MS, reducedMotion = defaultReducedMotion } = {}) {
  const live = []; // handles still on screen and not leaving, oldest first

  function reflow(before) {
    if (reducedMotion()) return;
    const moved = [];
    for (const h of live) {
      const prev = before.get(h.el);
      if (prev == null) continue;
      const dy = prev - h.el.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      h.el.style.transition = 'none';
      h.el.style.transform = `translateY(${dy}px)`;
      moved.push(h.el);
    }
    if (!moved.length) return;
    void container.offsetHeight; // commit the inverted position, then release it to animate
    for (const el of moved) { el.style.transition = ''; el.style.transform = ''; }
  }

  function show(el, { duration = 4000 } = {}) {
    const handle = { el, leaving: false, timer: null, dismiss, pause, resume };

    function pause() { clearTimeout(handle.timer); handle.timer = null; }
    function resume() {
      pause();
      if (handle.leaving || !(duration > 0)) return;
      handle.timer = setTimeout(dismiss, duration);
    }

    function dismiss() {
      if (handle.leaving) return;
      handle.leaving = true;
      pause();
      const i = live.indexOf(handle);
      if (i !== -1) live.splice(i, 1);
      const before = new Map(live.map((h) => [h.el, h.el.getBoundingClientRect().top]));
      const top = el.getBoundingClientRect().top;
      // Take it out of flow where it stands so the others reflow while it animates out.
      el.style.transition = '';
      el.style.position = 'absolute';
      el.style.top = `${top}px`;
      el.style.left = '0';
      el.style.right = '0';
      el.style.transform = '';
      el.classList.remove('show');
      el.classList.add('is-leaving');
      el.style.pointerEvents = 'none';
      el.setAttribute('aria-hidden', 'true');
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(fallback);
        el.removeEventListener('transitionend', onEnd);
        el.remove();
      };
      const onEnd = (e) => { if (e.target === el && (e.propertyName === 'opacity' || e.propertyName === 'transform')) finish(); };
      el.addEventListener('transitionend', onEnd);
      const fallback = setTimeout(finish, leaveFallbackMs);
      reflow(before);
    }

    container.appendChild(el);
    live.push(handle);
    // Enter on the next frames so the start state is painted first.
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    raf(() => raf(() => { if (!handle.leaving) el.classList.add('show'); }));
    resume();
    while (live.length > max) live[0].dismiss();
    return handle;
  }

  return { show, get count() { return live.length; } };
}

function defaultReducedMotion() {
  try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch (_) { return false; }
}
