// T-0 mock-ups: shared chrome (theme, mobile top bar, desktop header, six-item bottom nav).
// ?theme=dark | ?theme=light picks the theme (default light). <body data-nav="teams"> marks the active tab.
// <body data-chrome="none"> skips the app chrome (full-screen pages).
(function () {
  const q = new URLSearchParams(location.search);
  const theme = q.get('theme') === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  if (q.get('ct') === 'grid') document.documentElement.classList.add('ct-grid'); // screenshot aid: unroll the horizontal scroller

  const I = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
    timetable: '<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18"/><path d="M8 3v3M16 3v3"/>',
    bookings: '<circle cx="12" cy="8" r="4.2"/><path d="M4.5 20.5c1.6-3.6 4.4-5.4 7.5-5.4s5.9 1.8 7.5 5.4"/>',
    autobook: '<path d="M10 3.5c.4 3.4 2.1 5.1 5.5 5.5-3.4.4-5.1 2.1-5.5 5.5-.4-3.4-2.1-5.1-5.5-5.5 3.4-.4 5.1-2.1 5.5-5.5Z"/><path d="M17.5 13c.2 1.8 1.1 2.7 2.9 2.9-1.8.2-2.7 1.1-2.9 2.9-.2-1.8-1.1-2.7-2.9-2.9 1.8-.2 2.7-1.1 2.9-2.9Z"/><path d="M8 16.5c.15 1.3.8 1.95 2.1 2.1-1.3.15-1.95.8-2.1 2.1-.15-1.3-.8-1.95-2.1-2.1 1.3-.15 1.95-.8 2.1-2.1Z"/>',
    teams: '<circle cx="9" cy="8.5" r="3.4"/><path d="M2.8 19.5c1.1-3 3.4-4.6 6.2-4.6s5.1 1.6 6.2 4.6"/><circle cx="16.8" cy="9.6" r="2.7"/><path d="M15.6 14.3c2.6-.3 4.6 1.1 5.6 3.9"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.4 7.4 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 2.6-1.5l2.4 1 2-3.4Z"/>',
  };
  window.MOCK_ICONS = I;
  const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
  window.mockSvg = svg;

  function build() {
    const body = document.body;
    if (body.dataset.chrome === 'none') return;
    const active = body.dataset.nav || 'teams';
    const badge = body.dataset.badge || '';
    const items = [['home', 'Home'], ['timetable', 'Timetable'], ['bookings', 'Bookings'], ['autobook', 'Auto-Book'], ['teams', 'Teams'], ['settings', 'Settings']];
    const dItems = [['home', 'Home'], ['timetable', 'Class Timetable'], ['bookings', 'My Bookings'], ['autobook', 'Auto-Book'], ['teams', 'Teams'], ['settings', 'Settings']];

    const top = document.createElement('div');
    top.className = 'm-topbar';
    top.innerHTML = '<span class="gym-badge"><span class="gym-mark jab">JAB</span>∞</span><span class="gym-badge"><span class="gym-mark psy">PSY</span>18</span>';

    const dh = document.createElement('header');
    dh.className = 'd-header';
    dh.innerHTML = `<div class="d-header-top"><img class="d-logo" src="../../../client/public/icons/icon-192.png" alt=""><span class="d-brand">Dibs</span><span class="spacer"></span>
      <span class="muted sm">dev@psycle.com</span><span class="gym-badge"><span class="gym-mark jab">JAB</span>∞</span><span class="gym-badge"><span class="gym-mark psy">PSY</span>18 credits</span></div>
      <nav class="d-tabs">${dItems.map(([k, l]) => `<button class="d-tab${k === active ? ' active' : ''}">${l}${k === 'teams' && badge ? ` <span class="count-badge">${badge}</span>` : ''}</button>`).join('')}</nav>`;

    const nav = document.createElement('nav');
    nav.className = 'bnav';
    nav.setAttribute('aria-label', 'Main');
    nav.innerHTML = items.map(([k, l]) => `<button class="${k === active ? 'active' : ''}" aria-label="${l}"><span class="nb">${svg(k)}${k === 'teams' && badge ? `<i>${badge}</i>` : ''}</span><span class="lbl">${l}</span></button>`).join('');

    body.prepend(dh);
    body.prepend(top);
    body.append(nav);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
