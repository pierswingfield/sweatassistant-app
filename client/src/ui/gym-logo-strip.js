import { COPY, formatCopyText } from '../copy.js';
/** Decode once, then repeat at 16 CSS px/s. Same node/animation survives step updates. */
export async function startGymLogoDiscovery(strip) {
  if (!strip || strip.dataset.discoveryStarted) return;
  strip.dataset.discoveryStarted = 'true';
  const track = strip.querySelector('.app-onb-gym-logos-track');
  const sets = strip.querySelectorAll('.app-onb-gym-logos-set');
  if (!track || sets.length < 2) return;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let explicitPause = false, hovering = false, focused = false, animation = null;
  const update = () => {
    const paused = explicitPause || hovering || focused || motion.matches || strip.inert || strip.hidden;
    strip.dataset.paused = String(paused);
    strip.setAttribute('role', motion.matches ? 'group' : 'button');
    if (motion.matches) strip.removeAttribute('aria-pressed');
    else strip.setAttribute('aria-pressed', String(explicitPause));
    const action = explicitPause ? COPY.onboarding.logosResume : COPY.onboarding.logosPause;
    strip.setAttribute('aria-label', motion.matches ? COPY.onboarding.supportedGyms : formatCopyText(COPY.onboarding.logosAction, { action }));
    if (animation) { if (paused) animation.pause(); else animation.play(); }
  };
  strip.addEventListener('click', () => { explicitPause = !explicitPause; update(); });
  strip.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { hovering = true; update(); } });
  strip.addEventListener('pointerleave', () => { hovering = false; update(); });
  strip.addEventListener('focusin', () => { focused = true; update(); });
  strip.addEventListener('focusout', () => { focused = false; update(); });
  strip.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); explicitPause = !explicitPause; update(); }
    if (motion.matches && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
      event.preventDefault(); strip.scrollLeft += event.key === 'ArrowRight' ? 150 : -150;
    }
  });
  motion.addEventListener?.('change', update);
  strip.addEventListener('gym-logo-visibility', update);
  await Promise.all([...strip.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {})));
  const distance = sets[0].getBoundingClientRect().width;
  if (distance > 0) animation = track.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }], { duration: distance / 16 * 1000, iterations: Infinity, easing: 'linear' });
  update();
}

// Fade discovery away once the member has chosen a studio. The form moves with
// a transform after reflow; rapid selection changes cancel the old exit safely.
const visibilityRuns = new WeakMap();
export function setGymLogoDiscoveryVisible(strip, visible, { anchor, focusTarget, animate = true } = {}) {
  if (!strip) return;
  const previous = visibilityRuns.get(strip);
  previous?.animation?.cancel();
  previous?.movement?.cancel();
  const run = {};
  visibilityRuns.set(strip, run);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const style = getComputedStyle(strip);
  const duration = (token, fallback) => { const value = style.getPropertyValue(token).trim(); return value ? parseFloat(value) * (value.endsWith('ms') ? 1 : 1000) : fallback; };
  const easing = style.getPropertyValue('--ease-out').trim() || 'ease-out';
  const moveForm = (before) => {
    if (!anchor || !animate || reduce) return;
    const shift = before - anchor.getBoundingClientRect().top;
    if (shift) run.movement = anchor.animate([{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], {
      duration: duration('--dur-slow', 240), easing,
    });
  };
  if (!visible && strip.contains(document.activeElement)) focusTarget?.focus({ preventScroll: true });
  strip.inert = !visible;
  if (visible) strip.removeAttribute('aria-hidden');
  else strip.setAttribute('aria-hidden', 'true');
  if (visible) {
    const before = anchor?.getBoundingClientRect().top;
    const wasHidden = strip.hidden;
    strip.hidden = false;
    strip.dispatchEvent(new Event('gym-logo-visibility'));
    if (wasHidden) moveForm(before);
    if (animate && !reduce) run.animation = strip.animate([{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: duration('--dur-base', 180), easing });
    return;
  }
  strip.dispatchEvent(new Event('gym-logo-visibility'));
  const hide = () => {
    if (visibilityRuns.get(strip) !== run) return;
    const before = anchor?.getBoundingClientRect().top;
    strip.hidden = true;
    moveForm(before);
  };
  if (!animate || reduce || strip.hidden) return hide();
  run.animation = strip.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-6px)' }], { duration: duration('--dur-base', 180), easing, fill: 'forwards' });
  run.animation.finished.then(hide, () => {});
}
