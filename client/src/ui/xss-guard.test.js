// Security audit part 1: provider/server data must never become markup.
// Renders the real components with hostile class/instructor/studio/location/bundle
// names, profile fields and URLs, then asserts nothing was injected: no element
// carries an on* handler, no <script>/<iframe>/<object>, no stray <img src=x> or
// <svg onload>, and every href/src is a safe scheme. The hostile text must still
// be VISIBLE as text (so the escaping is not just dropping data).
import { describe, it, expect, beforeAll, vi } from 'vitest';

const EVIL = `X<img src=x onerror=alert(1)>"><svg onload=alert(2)>'><b>bold</b>`;
const EVIL_URL = 'javascript:alert(3)';

function assertInert(root, { expectText = true } = {}) {
  const all = root.querySelectorAll('*');
  for (const el of all) {
    for (const attr of el.getAttributeNames()) {
      expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
    }
    expect(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'B'].includes(el.tagName), `${el.tagName} injected`).toBe(false);
    if (el.tagName === 'IMG') expect(el.getAttribute('src'), 'injected <img src=x>').not.toBe('x');
    for (const a of ['href', 'src']) {
      const v = el.getAttribute(a);
      if (v != null) expect(/^\s*(javascript|data|vbscript):/i.test(v), `${el.tagName}[${a}]=${v}`).toBe(false);
    }
  }
  if (expectText) expect(root.textContent + root.innerHTML).toContain('onerror=alert(1)');
}

function mountHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

let mods = {};
beforeAll(async () => {
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  if (typeof localStorage === 'undefined' || localStorage === null || !localStorage.getItem) {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
      clear: () => store.clear(),
    });
  }
  mods.main = await import('../main.js');
  mods.timetable = await import('./timetable.js');
  mods.bookings = await import('./bookings.js');
  mods.tooltips = await import('./tooltips.js');
  mods.cards = await import('./cards.js');
  mods.overlap = await import('./overlap-modal.js');
  mods.credits = await import('./credits.js');
  mods.gymSettings = await import('./gym-settings-section.js');
  mods.settings = await import('./settings.js');
  mods.home = await import('./home.js');
  mods.autobook = await import('./autobook.js');
  mods.safeUrl = await import('./safe-url.js');
});

const START = '2099-03-04T18:30:00+00:00';
const evilEvent = (extra = {}) => ({
  id: `e1${EVIL}`, gymId: 'psycle-london', name: EVIL, discipline: EVIL, startAt: START, endAt: START, durationMin: 45,
  timeZone: 'Europe/London', studioId: 's1', studioName: EVIL, locationId: 'l1', locationName: EVIL, locationAddress: EVIL,
  instructors: [{ id: `i1${EVIL}`, name: EVIL, thumbUrl: EVIL_URL, imageUrl: EVIL_URL }],
  capacity: 20, availableCount: 5, isFull: false, waitlistAvailable: true, layoutFormat: 'pick-a-spot', ...extra,
});

describe('XSS guard: hostile provider data renders as text', () => {
  it('timetable desktop row', () => {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    document.body.appendChild(table);
    mods.timetable.renderEventRowsInto(tbody, [evilEvent()]);
    assertInert(table);
  });

  it('timetable mobile card', () => {
    const orig = window.matchMedia;
    window.matchMedia = (q) => ({ matches: /max-width/.test(q), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
    try {
      const table = document.createElement('table');
      const tbody = document.createElement('tbody');
      table.appendChild(tbody);
      document.body.appendChild(table);
      mods.timetable.renderEventRowsInto(tbody, [evilEvent()]);
      assertInert(table);
    } finally { window.matchMedia = orig; }
  });

  it('bookings card', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const event = evilEvent();
    mods.bookings.mountBookingCard(container, {
      eventId: event.id, gymId: event.gymId, event,
      bookings: [{ bookingId: `b1${EVIL}`, id: `b1${EVIL}`, slotId: '7', slotLabel: EVIL, gymId: event.gymId, event }],
    }, []);
    assertInert(container);
  });

  it('auto-book queue card and history', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="app-autobook-queue-container"></div><div id="app-autobook-history-container"></div><div id="app-autobook-history"></div>');
    const row = {
      id: 1, event_id: `e${EVIL}`, gym_id: 'psycle-london', class_name: EVIL, group_name: EVIL, instructor_name: EVIL,
      instructor_image_url: EVIL_URL, studio_name: EVIL, location_name: EVIL, start_at: START, preferences: {},
      warnings: [{ code: EVIL, message: EVIL }],
    };
    mods.main.cache.autoBookings = [row, { ...row, id: 2, executed_at: START, status: 'failed' }];
    mods.autobook.repaintAutoBookFromCache();
    assertInert(document.getElementById('app-autobook-queue-container'));
  });

  it('instructor tooltip: name/bio escaped, javascript: socials and photo dropped', () => {
    const html = mods.tooltips.instructorTooltipHTML('nope', 'psycle-london', { name: EVIL, photo: EVIL_URL });
    assertInert(mountHtml(html));
    // Metadata path, with bio + hostile social URLs.
    mods.timetable.mergeMetadataFromEvents?.([]);
    const { metadata } = mods.timetable;
    if (metadata && Array.isArray(metadata.instructors)) {
      metadata.instructors.push({
        id: 'evil-1', gymId: 'psycle-london', name: EVIL, bio: EVIL, imageUrl: EVIL_URL,
        instagramUrl: EVIL_URL, spotifyUrl: 'data:text/html,<script>alert(1)</script>',
        metafields: { keywords: EVIL, instagram_handle: `"><svg onload=alert(4)>` },
      });
      const root = mountHtml(mods.tooltips.instructorTooltipHTML('evil-1', 'psycle-london'));
      assertInert(root);
      for (const a of root.querySelectorAll('a')) {
        expect(a.getAttribute('href')).toMatch(/^https:\/\/(www\.)?instagram\.com\/|^https:\/\/open\.spotify\.com\//);
        expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      }
    }
  });

  it('instructor avatar never emits a javascript:/data: src', () => {
    expect(mods.tooltips.instructorAvatar(EVIL, 'psycle-london', EVIL_URL)).toBe('');
    const ok = mountHtml(mods.tooltips.instructorAvatar(EVIL, 'psycle-london', '/api/instructor-photo/g/1?size=thumb'));
    assertInert(ok, { expectText: false });
    expect(ok.querySelector('img').getAttribute('src')).toBe('/api/instructor-photo/g/1?size=thumb');
  });

  it('shared card helpers and overlap summary', () => {
    assertInert(mountHtml(mods.cards.disciplineTag(EVIL) + mods.cards.instructorInlineHtml(EVIL)));
    assertInert(mountHtml(mods.overlap.classSummaryCardHtml({
      gymId: 'psycle-london', className: EVIL, groupName: EVIL, instructorName: EVIL, studioName: EVIL, locationName: EVIL, startAt: START,
    }, EVIL)));
  });

  it('credits bundle card', () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="app-bundles-container"></div>');
    mods.main.cache.bundles = [{
      id: 99, name: `10 Class Pack ${EVIL}`, handle: EVIL, description: EVIL, price: 1500, total_credits: 1,
      is_first_purchase_only: false, is_one_time_purchase_only: false, studios: [], event_types: [],
    }];
    mods.credits.renderBundles();
    const root = document.getElementById('app-bundles-container');
    expect(root.querySelectorAll('.fav-card').length).toBe(1);
    assertInert(root);
  });

  it('gym membership summary (Settings) escapes fields and drops a javascript: manage URL', () => {
    const html = mods.gymSettings.membershipHtml(
      { id: 'jab-boxing', name: EVIL, websiteUrl: EVIL_URL, capabilities: { metered: false } },
      { name: EVIL, status: EVIL, isActive: true, manageUrl: EVIL_URL, renewsAt: START },
      [],
    );
    const root = mountHtml(html);
    assertInert(root);
    expect(root.querySelector('a')).toBeNull();
  });

  it('settings gym connection row', () => {
    const g = { gym_id: `jab${EVIL}`, gym_name: EVIL, gym_email: EVIL, provider: EVIL, last_authenticated_at: START };
    const row = mods.settings.connRowCreate(g);
    document.body.appendChild(row);
    mods.settings.connRowUpdate(row, g);
    assertInert(row, { expectText: false });
    expect(row.textContent).toContain('onerror=alert(1)');
  });

  it('Home favourite card', () => {
    const card = mods.home.renderHomeFavouriteCard(evilEvent(), () => ({ label: EVIL, variant: 'success' }), () => '');
    document.body.appendChild(card);
    assertInert(card);
  });
});

describe('safe-url', () => {
  it('safeHttpsUrl allows https on the expected hosts only', () => {
    const { safeHttpsUrl, INSTAGRAM_HOSTS, SPOTIFY_HOSTS } = mods.safeUrl;
    expect(safeHttpsUrl('https://instagram.com/x', INSTAGRAM_HOSTS)).toBe('https://instagram.com/x');
    expect(safeHttpsUrl('https://www.instagram.com/x', INSTAGRAM_HOSTS)).toBe('https://www.instagram.com/x');
    expect(safeHttpsUrl('https://open.spotify.com/user/a', SPOTIFY_HOSTS)).toBe('https://open.spotify.com/user/a');
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'http://instagram.com/x',
      'https://evil.example/instagram.com', 'https://instagram.com.evil.example/', 'https://user:pw@instagram.com/', '//instagram.com/x', 'vbscript:x', '']) {
      expect(safeHttpsUrl(bad, INSTAGRAM_HOSTS), bad).toBe('');
    }
    expect(safeHttpsUrl('https://anything.example/a')).toBe('https://anything.example/a');
    expect(safeHttpsUrl('ftp://anything.example/a')).toBe('');
  });

  it('safeImageUrl allows same-origin paths and https only', () => {
    const { safeImageUrl } = mods.safeUrl;
    expect(safeImageUrl('/api/instructor-photo/a/1?size=thumb')).toBe('/api/instructor-photo/a/1?size=thumb');
    expect(safeImageUrl('https://cdn.example/a.png')).toBe('https://cdn.example/a.png');
    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', '//evil.example/a.png', '/\\evil.example', 'http://x/a.png', null]) {
      expect(safeImageUrl(bad), String(bad)).toBe('');
    }
  });
});
