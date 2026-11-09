import { COPY, formatCopyText } from '../copy.js';
import { escapeHtml as esc } from '../escape-html.js';
import { chartCard, busiestDaysHtml, gymMixHtml, busiestTimesHtml } from './stats-charts.js';
const C = COPY.home;
export function personalStatsZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } }
export function personalStatsKey(zone = personalStatsZone()) { return `/api/personal-stats?zone=${encodeURIComponent(zone)}`; }
// Calendar keys are already in the viewer's zone. UTC arithmetic avoids DST-length days.
export function volumeWeeks(points) {
  return points.map(p => {
    const day = Math.floor(Date.parse(`${p.date}T00:00:00Z`) / 86400000);
    const monday = day - ((day + 3) % 7 + 7) % 7;
    return { ...p, band: ((Math.floor((monday + 3) / 7) % 2) + 2) % 2, monday: day === monday };
  });
}
function volumeChart(points) {
  const days = volumeWeeks(points), max = Math.max(1, ...days.map(p => p.count));
  const aria = days.map(p => `${p.date}: ${p.count} ${C.statsPastClasses}`).join(', ');
  const bars = days.map((p, i) => `<span class="tm-vbar personal-volume-day band-${p.band}" tabindex="0" aria-label="${esc(`${p.date}: ${p.count} ${C.statsPastClasses}`)}"><i style="height:${Math.max(p.count ? 6 : 2, Math.round(p.count / max * 100))}%"></i>${(p.monday && i >= 3 && i <= days.length - 4) ? `<span class="tm-vbar-lab">${esc(p.date.slice(5))}</span>` : ''}</span>`).join('');
  return chartCard(C.statsTrainingVolume, '', `<div class="tm-vbars personal-volume-bars">${bars}</div>`, aria, { interactive: true, period: C.statsLast30 });
}
export function renderPersonalStats(el, data) {
  const weeks = data.streak?.weeks || 0;
  const weekLabel = weeks === 1 ? C.statsWeekOne : formatCopyText(C.statsWeekMany, { count: weeks });
  const unresolvedZero = (data.pending || data.partial) && !data.totalPastClasses;
  el.innerHTML = unresolvedZero ? '' : `<div class="tm-stat-tiles personal-stat-tiles"><div class="tm-stat-tile"><span class="tm-stat-big">${esc(weekLabel)}</span><span class="tm-stat-label">${esc(C.statsStreak)}</span></div></div>`;
  if (!data.totalPastClasses) return;
  const charts = { busiestDays: data.patterns.weekdays, gymMix: data.patterns.gymMix, busiestTimes: data.patterns.hours || [] };
  const options = { period: C.statsLast90, emptyText: C.statsNoRecent };
  const slides = [volumeChart(data.volume.points), busiestDaysHtml(charts, options), gymMixHtml(charts, options), busiestTimesHtml(charts, options)];
  const rail = document.createElement('div'); rail.className = 'tm-stats-carousel personal-stats-carousel'; rail.tabIndex = 0; rail.setAttribute('aria-label', C.stats);
  rail.innerHTML = slides.map((html, i) => `<div class="tm-stats-slide" aria-label="${i + 1} / ${slides.length}">${html}</div>`).join('');
  const dots = document.createElement('div'); dots.className = 'tm-dots tm-stats-dots personal-stats-dots';
  dots.innerHTML = slides.map((_, i) => `<button type="button" aria-label="${esc(`${C.stats}, ${i + 1} / ${slides.length}`)}"${i === 0 ? ' aria-current="true"' : ''}><i class="${i === 0 ? 'is-on' : ''}"></i></button>`).join('');
  const buttons = [...dots.querySelectorAll('button')];
  const sync = () => { const slide = rail.querySelector('.tm-stats-slide'); const step = slide ? slide.getBoundingClientRect().width + 10 : 1; const index = Math.min(buttons.length - 1, Math.max(0, Math.round(rail.scrollLeft / Math.max(1, step)))); buttons.forEach((b, i) => { b.querySelector('i').classList.toggle('is-on', i === index); if (i === index) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }); };
  buttons.forEach((b, i) => b.addEventListener('click', () => { const slide = rail.children[i]; rail.scrollTo({ left: i * (slide.getBoundingClientRect().width + 10), behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }));
  rail.addEventListener('scroll', sync, { passive: true });
  rail.addEventListener('keydown', e => { if (e.target === rail && ['ArrowRight', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); const current = buttons.findIndex(b => b.hasAttribute('aria-current')); buttons[Math.max(0, Math.min(buttons.length - 1, current + (e.key === 'ArrowRight' ? 1 : -1)))].click(); } });
  el.append(rail, dots); sync();
  if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(() => { if (!rail.isConnected) observer.disconnect(); else sync(); }); observer.observe(rail); }
}
