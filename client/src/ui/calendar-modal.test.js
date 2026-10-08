import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let openCalendarSettingsModal;
let renderCalendarSection;
let api;
const mobile = (matches) => { window.matchMedia = (query) => ({ matches, media: query, addEventListener() {}, removeEventListener() {} }); };

beforeAll(async () => {
  mobile(true);
  if (typeof localStorage === 'undefined' || localStorage === null || !localStorage.getItem) {
    const store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }, clear: () => store.clear(),
    });
  }
  ({ openCalendarSettingsModal, renderCalendarSection } = await import('./calendar-section.js'));
  ({ api } = await import('../api.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('onboarding calendar settings modal', () => {
  it('is a full-screen page on mobile with a Done button that closes it once', async () => {
    mobile(true);
    const onClose = vi.fn();
    openCalendarSettingsModal({ onClose });
    const overlay = document.querySelector('.app-ovl');
    expect(overlay.classList.contains('app-page')).toBe(true);
    const done = overlay.querySelector('.app-btn-primary[data-calendar-modal-close]');
    expect(done).not.toBeNull();
    done.click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on desktop and calls onClose once', () => {
    mobile(false);
    const onClose = vi.fn();
    openCalendarSettingsModal({ onClose });
    document.querySelector('.app-btn-primary[data-calendar-modal-close]').click();
    expect(document.querySelector('.app-ovl')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hands Google Calendar to the browser with a transient anchor', async () => {
    mobile(false);
    const root = document.createElement('div');
    document.body.appendChild(root);
    vi.spyOn(api, 'getCalendarStatus').mockResolvedValue({
      enabled: true,
      links: { google: 'https://calendar.google.com/calendar/u/0/r?cid=http://feed.example/test.ics' },
      gyms: [],
      reminders: {},
    });
    const opened = vi.spyOn(window, 'open');
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.href).toContain('calendar.google.com');
      expect(this.target).toBe('_blank');
      expect(this.rel).toBe('noopener noreferrer');
    });

    await renderCalendarSection(root);
    root.querySelector('[data-calendar-action="google"]').click();

    expect(clicked).toHaveBeenCalledOnce();
    expect(opened).not.toHaveBeenCalled();
    expect(document.body.querySelector('a[href*="calendar.google.com"]')).toBeNull();
  });
});
