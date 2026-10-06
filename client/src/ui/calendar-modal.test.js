import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let openCalendarSettingsModal;
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
  ({ openCalendarSettingsModal } = await import('./calendar-section.js'));
});

afterEach(() => { document.body.innerHTML = ''; });

describe('onboarding calendar settings modal', () => {
  it('is a full-screen page on mobile with a Done button that closes it once', async () => {
    mobile(true);
    const onClose = vi.fn();
    openCalendarSettingsModal({ onClose });
    const overlay = document.querySelector('.psycle-ovl');
    expect(overlay.classList.contains('psycle-page')).toBe(true);
    const done = overlay.querySelector('.psycle-btn-primary[data-calendar-modal-close]');
    expect(done).not.toBeNull();
    done.click();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2000 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on desktop and calls onClose once', () => {
    mobile(false);
    const onClose = vi.fn();
    openCalendarSettingsModal({ onClose });
    document.querySelector('.psycle-btn-primary[data-calendar-modal-close]').click();
    expect(document.querySelector('.psycle-ovl')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
