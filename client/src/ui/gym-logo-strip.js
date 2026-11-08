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
    const paused = explicitPause || hovering || focused || motion.matches;
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
  await Promise.all([...strip.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {})));
  const distance = sets[0].getBoundingClientRect().width;
  if (distance > 0) animation = track.animate([{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }], { duration: distance / 16 * 1000, iterations: Infinity, easing: 'linear' });
  update();
}
