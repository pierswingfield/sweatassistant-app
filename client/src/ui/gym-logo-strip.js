/** One decoded, stable strip. Discovery ends within 4.5s; all interaction stops it. */
export async function startGymLogoDiscovery(strip) {
  if (!strip || strip.dataset.discoveryStarted) return;
  strip.dataset.discoveryStarted = 'true';
  let stopped = false;
  const stop = () => { stopped = true; };
  for (const event of ['pointerenter', 'pointerdown', 'focusin', 'wheel', 'touchstart']) strip.addEventListener(event, stop, { passive: true });
  strip.addEventListener('keydown', (event) => {
    stop();
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault(); strip.scrollLeft += event.key === 'ArrowRight' ? 150 : -150;
    }
  });
  await Promise.all([...strip.querySelectorAll('img')].map((img) => img.decode?.().catch(() => {})));
  if (stopped || !strip.isConnected || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const distance = strip.scrollWidth - strip.clientWidth;
  if (distance <= 0) return;
  let start;
  const frame = (now) => {
    if (stopped || !strip.isConnected) return;
    start ??= now;
    const progress = Math.min(1, (now - start) / 4500);
    strip.scrollLeft = distance * (1 - Math.cos(Math.PI * progress)) / 2;
    if (progress < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
