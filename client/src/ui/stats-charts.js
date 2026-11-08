import { escapeHtml, gymSquareChip, gymBrand } from './cards.js';
import { getGymShortName } from '../gym-context.js';
import { COPY, formatCopyText } from '../copy.js';
const T = COPY.teams;
const fmt = formatCopyText;
import { busiestDaysView, busiestTimesView, gymMixView } from './teams-stats-model.js';

export function chartCard(title, meta, body, aria, { interactive = false, period = "" } = {}) {
  return `<figure class="tm-chart" role="group" aria-label="${escapeHtml(title)}">
    <figcaption class="tm-chart-title">${escapeHtml(title)}</figcaption>${period ? `<span class="personal-chart-period">${escapeHtml(period)}</span>` : ''}
    <div role="${interactive ? 'group' : 'img'}" aria-label="${escapeHtml(aria)}">${body}</div>
  </figure>`;
}
const emptyChart = (text = T.statsChartEmpty) => `<p class="tm-muted tm-sm tm-chart-empty">${escapeHtml(text)}</p>`;

export function busiestDaysHtml(charts, options = {}) {
  const v = busiestDaysView(charts.busiestDays);
  const aria = fmt(T.busiestDaysAria, { list: v.bars.map((b) => `${b.long} ${b.count}`).join(', ') });
  const body = v.total ? `<div class="tm-vbars tm-vbars-days">${v.bars.map((b) => `<span class="tm-vbar${b.isPeak ? ' is-peak' : ''}"><i style="height:${Math.max(b.count ? 6 : 2, Math.round(b.frac * 100))}%"></i><span class="tm-vbar-lab">${escapeHtml(b.label)}</span></span>`).join('')}</div>` : emptyChart(options.emptyText);
  const meta = v.total ? `${T.last4Weeks}${v.peakName ? ` · ${fmt(T.teamsDay, { day: v.peakName })}` : ''}` : '';
  return chartCard(T.busiestDays, meta, body, options.period ? `${T.busiestDays}, ${options.period}: ${v.bars.map(b => `${b.long} ${b.count}`).join(', ')}` : aria, options);
}

export function gymMixHtml(charts, options = {}) {
  const v = gymMixView(charts.gymMix, (gymId) => {
    const b = gymBrand(gymId, 'half');
    return { name: getGymShortName(gymId) || b.name || '', colour: b.brandBg || '' };
  });
  const safeColour = (c) => (/^#[0-9a-f]{3,8}$/i.test(c) || /^rgba?\([\d\s.,%]+\)$/i.test(c) ? c : 'var(--text-secondary)');
  const aria = fmt(T.gymMixAria, { list: v.rows.map((r) => `${r.name} ${r.percent}%`).join(', ') });
  const body = v.total ? `<ul class="tm-mix">${v.rows.map((r) => `<li class="tm-mix-row">
      <span class="tm-mem-gym">${gymSquareChip(r.gymId)}</span><span class="tm-mix-name tm-ellip">${escapeHtml(r.name)}</span>
      <span class="tm-mix-track"><i style="width:${Math.max(4, Math.round(r.frac * 100))}%;background:${safeColour(r.colour)}"></i></span>
      <b class="tm-mix-pc">${r.percent}%</b></li>`).join('')}</ul>` : emptyChart(options.emptyText);
  return chartCard(T.gymMix, v.total ? `${T.last4Weeks} · ${T.gymMixNote}` : '', body, options.period ? `${T.gymMix}, ${options.period}: ${v.rows.map(r => `${r.name} ${r.percent}%`).join(', ')}` : aria, options);
}

export function busiestTimesHtml(charts, options = {}) {
  const v = busiestTimesView(charts.busiestTimes);
  const aria = fmt(T.busiestTimesAria, { list: v.bars.filter((b) => b.count).map((b) => `${b.label} ${b.count}`).join(', ') || '0' });
  const body = v.total ? `<div class="tm-vbars tm-vbars-times">${v.bars.map((b) => `<span class="tm-vbar${b.isPeak ? ' is-peak' : ''}"><i style="height:${Math.max(b.count ? 6 : 2, Math.round(b.frac * 100))}%"></i><span class="tm-vbar-lab">${b.tick ? escapeHtml(b.label) : ''}</span></span>`).join('')}</div>` : emptyChart(options.emptyText);
  return chartCard(T.busiestTimes, v.total ? T.last4Weeks : '', body, options.period ? `${T.busiestTimes}, ${options.period}: ${v.bars.map(b => `${b.label} ${b.count}`).join(', ')}` : aria, options);
}
