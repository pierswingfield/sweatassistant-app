import { COPY, formatCopyText } from '../copy.js';
import { escapeHtml as esc } from '../escape-html.js';
import { getGymShortName } from '../gym-context.js';
const C = COPY.home;
export function personalStatsZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } }
export function personalStatsKey(zone = personalStatsZone()) { return `/api/personal-stats?zone=${encodeURIComponent(zone)}`; }
export function personalStatsNotes(data) {
  const states = data.coverage || [];
  return [data.pending && C.statsImporting, states.some(c => c.state === 'failed') && C.statsIncomplete,
    states.some(c => c.state === 'stale') && C.statsStale, states.some(c => c.state === 'disabled') && C.statsDisabled,
    states.some(c => c.limited) && C.statsLimited].filter(Boolean);
}
function chartCard(title, period, body, subtitle = '') {
  return `<section class="personal-chart" tabindex="0" aria-label="${esc(`${title}, ${period}`)}"><header><h4>${esc(title)}</h4><span>${esc(period)}</span></header>${subtitle ? `<p class="personal-chart-zone">${esc(subtitle)}</p>` : ''}${body}</section>`;
}
function barRows(rows, { mix = false } = {}) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return `<ol class="personal-bars${mix ? ' personal-mix' : ''}">${rows.map(r => `<li><span class="personal-bar-label">${esc(r.label)}</span><span class="personal-bar-track" aria-hidden="true"><i style="width:${r.count / max * 100}%"></i></span><span class="personal-bar-value">${r.count}${mix ? ` <small>· ${r.percent}%</small>` : ''}</span></li>`).join('')}</ol>`;
}
function dailyLine(points) {
  const max = Math.max(1, ...points.map(p => p.count));
  const x = i => 24 + i / 29 * 244, y = n => 120 - n / max * 94;
  const coords = points.map((p,i) => `${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(' ');
  const summary = `${points.reduce((n,p)=>n+p.count,0)} ${C.statsPastClasses}`;
  return `<svg class="personal-line" viewBox="0 0 282 154" role="img" aria-label="${esc(`${C.statsTrainingVolume}: ${summary}`)}"><line x1="24" y1="120" x2="268" y2="120" class="personal-axis"/><line x1="24" y1="26" x2="268" y2="26" class="personal-gridline"/><text x="16" y="123" text-anchor="end">0</text><text x="16" y="30" text-anchor="end">${max}</text><polygon points="24,120 ${coords} 268,120" class="personal-area"/><polyline points="${coords}" class="personal-line-path"/>${points.map((p,i)=>`<circle cx="${x(i)}" cy="${y(p.count)}" r="3" tabindex="0" role="img" aria-label="${esc(`${p.date}: ${p.count} ${C.statsPastClasses}`)}"><title>${esc(`${p.date}: ${p.count}`)}</title></circle>`).join('')}<text x="24" y="145">${esc(points[0]?.date.slice(5) || '')}</text><text x="268" y="145" text-anchor="end">${esc(points.at(-1)?.date.slice(5) || '')}</text></svg><p class="personal-line-readout" aria-live="polite"></p><details class="personal-chart-details"><summary>${esc(C.statsDetails)}</summary><table><thead><tr><th>${esc(C.statsDate)}</th><th>${esc(C.statsCount)}</th></tr></thead><tbody>${points.map(p=>`<tr><th scope="row">${esc(p.date)}</th><td>${p.count}</td></tr>`).join('')}</tbody></table></details>`;
}
export function renderPersonalStats(el, data, { retry = () => {} } = {}) {
  const notes = personalStatsNotes(data);
  const weeks = data.streak?.weeks || 0;
  const weekLabel = weeks === 1 ? C.statsWeekOne : formatCopyText(C.statsWeekMany,{count:weeks});
  const unresolvedZero = (data.pending || data.partial) && !data.totalPastClasses;
  el.innerHTML = `<div class="personal-stats-summary">${unresolvedZero ? '' : `<p class="personal-streak"><span class="personal-streak-mark" aria-hidden="true">✦</span><strong>${esc(data.streak?.atLeast ? formatCopyText(C.statsAtLeast,{weeks:weekLabel}) : weekLabel)}</strong><span>${esc(C.statsWeeklyStreak)}</span></p>`}<p class="personal-stats-basis">${esc(C.statsBasis)}</p></div>${notes.length ? `<div class="personal-coverage" role="status"><p>${notes.map(esc).join(' ')}</p><button type="button" class="app-btn-mini" data-stats-retry>${esc(C.retry)}</button></div>` : ''}`;
  el.querySelector('[data-stats-retry]')?.addEventListener('click',retry);
  if (!data.totalPastClasses) {
    if (!unresolvedZero) { const p=document.createElement('p');p.className='home-widget-empty';p.textContent=C.statsEmptyHistory;el.append(p); }
    return;
  }
  const patterns = data.patterns;
  const total = patterns.weekdays.reduce((a,b)=>a+b,0);
  const rail = document.createElement('div'); rail.className='personal-chart-rail'; rail.tabIndex=0; rail.setAttribute('aria-label',C.stats);
  rail.innerHTML = chartCard(C.statsTrainingVolume,C.statsLast30,dailyLine(data.volume.points))
    + chartCard(C.statsBusiestDays,C.statsLast90,barRows(patterns.weekdays.map((count,i)=>({label:C.statsWeekdays[i],count}))),C.statsLocalTimes)
    + chartCard(C.statsGymMix,C.statsLast90,total ? barRows(patterns.gymMix.map(r=>({...r,label:getGymShortName(r.gymId)||r.gymId})),{mix:true}) : `<p class="home-widget-empty">${esc(C.statsNoRecent)}</p>`)
    + chartCard(C.statsBusiestTimes,C.statsLast90,barRows(patterns.timeBins.map((count,i)=>({label:C.statsTimes[i],count}))),C.statsLocalTimes);
  const showPoint = (event) => {
    const point = event.target.closest?.('.personal-line circle');
    if (point) rail.querySelector('.personal-line-readout').textContent = point.getAttribute('aria-label');
  };
  rail.addEventListener('focusin', showPoint);
  rail.addEventListener('pointerover', showPoint);
  const controls=document.createElement('div');controls.className='personal-chart-controls';
  for (const [label,direction,glyph] of [[C.statsPrevious,-1,'←'],[C.statsNext,1,'→']]) {
    const b=document.createElement('button');b.type='button';b.className='app-btn-mini';b.setAttribute('aria-label',label);b.textContent=glyph;
    b.addEventListener('click',()=>rail.scrollBy({left:direction*(rail.querySelector('section').getBoundingClientRect().width+12),behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'}));controls.append(b);
  }
  rail.addEventListener('keydown',e=>{if(e.target===rail&&['ArrowRight','ArrowLeft'].includes(e.key)){e.preventDefault();rail.scrollBy({left:e.key==='ArrowRight'?300:-300,behavior:'instant'});}});
  el.append(controls,rail);
}
