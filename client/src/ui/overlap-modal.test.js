import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The avatar helper reads timetable metadata (a heavy import chain); the modal
// only needs "photo url in -> <img> out".
vi.mock('./tooltips.js', () => ({
  instructorAvatar: (name, gymId, url) => (url ? `<img class="ab-card-avatar" src="${url}">` : ''),
}));

import { describeOverlap, classSummaryCardHtml, confirmOverlap } from './overlap-modal.js';

const subject = {
  gymId: 'jab-boxing', startAt: '2026-10-09T12:15:00.000Z', className: 'TRAIN - Full Body Conditioning',
  groupName: 'TRAIN - Full Body Conditioning', instructorName: 'Simi', instructorImageUrl: 'https://img.example/s.jpg',
  studioName: 'TRAIN', locationName: 'JAB SW1',
};
const clash = {
  code: 'OVERLAP_QUEUED', crossGym: true,
  with: { gymId: 'psycle-london', startAt: '2026-10-09T12:15:00.000Z', className: 'Barre Express 30', groupName: 'Barre', instructorName: 'Imani', studioName: 'Barre Studio', locationName: 'Psycle Mortimer Street' },
};

describe('describeOverlap', () => {
  it('names what it overlaps from the codes, and tags each clashing card', () => {
    const d = describeOverlap([clash, { code: 'OVERLAP_BOOKED', with: { className: 'B' } }]);
    expect(d.title).toBe('Overlapping class');
    expect(d.lead).toContain('a class you have booked');
    expect(d.lead).toContain('another class in your auto-book queue');
    expect(d.clashes.map((c) => c.tag)).toEqual(['In your queue', 'Booked']);
  });
  it('an already-booked class gets its own title', () => {
    const d = describeOverlap([{ code: 'ALREADY_BOOKED', with: { className: 'X' } }]);
    expect(d.title).toBe('Already booked');
  });
  it('caps the stack and reports the remainder', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ code: 'OVERLAP_QUEUED', with: { className: `C${i}` } }));
    const d = describeOverlap(many);
    expect(d.clashes).toHaveLength(3);
    expect(d.hiddenCount).toBe(2);
  });
  it('never treats a duplicate as confirmable content', () => {
    expect(describeOverlap([{ code: 'DUPLICATE_QUEUED', with: {} }]).clashes).toEqual([]);
  });
});

describe('classSummaryCardHtml', () => {
  it('uses the shared card: gym rail, discipline pill, class, instructor photo + name, location', () => {
    const html = classSummaryCardHtml(subject, 'New');
    expect(html).toContain('sa-autobook-card ab-card');
    expect(html).toContain('data-gym="jab-boxing"');
    expect(html).toContain('ab-card-gym-rail');
    expect(html).toContain('ab-disc-tag');
    expect(html).toContain('Simi');
    expect(html).toContain('ab-card-avatar');
    expect(html).toContain('TRAIN, ');
  });
  it('drops the redundant discipline prefix from a gym whose discipline is the whole class type', () => {
    const html = classSummaryCardHtml(subject, 'New');
    expect(html).toContain('>Full Body Conditioning<');
  });
  it('escapes server- and gym-supplied text', () => {
    const html = classSummaryCardHtml({ ...subject, className: '<img src=x onerror=alert(1)>', instructorName: '"><script>x</script>' }, '<b>');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;b&gt;');
  });
});

describe('confirmOverlap dialog', () => {
  let opener;
  beforeEach(() => {
    document.body.innerHTML = '';
    opener = document.createElement('button');
    opener.textContent = 'Schedule Auto-Book';
    document.body.appendChild(opener);
    opener.focus();
  });
  afterEach(() => {
    // Every test closes its own dialog; this only guards against one that failed mid-way.
    document.querySelector('.sa-overlap-modal [data-overlap-cancel]')?.click();
  });
  const open = () => confirmOverlap({ subject, warnings: [clash] });
  const dlg = () => document.querySelector('.sa-overlap-modal');
  const press = (key, opts = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
    (document.activeElement || document.body).dispatchEvent(e);
    return e;
  };

  it('is a labelled modal dialog with the new class and the clash as cards', () => {
    open();
    const d = dlg();
    expect(d.getAttribute('role')).toBe('dialog');
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d.getAttribute('aria-labelledby')).textContent).toBe('Overlapping class');
    expect(document.getElementById(d.getAttribute('aria-describedby')).textContent).toContain('overlaps');
    expect(d.querySelectorAll('.sa-overlap-card')).toHaveLength(2);
    expect(d.textContent).toContain('Auto-book anyway');
    expect(d.textContent).toContain('Cancel');
  });

  it('moves focus into the dialog, onto the safe choice', () => {
    open();
    expect(document.activeElement.textContent).toBe('Cancel');
    expect(dlg().contains(document.activeElement)).toBe(true);
  });

  it('"Auto-book anyway" resolves true and returns focus to the trigger', async () => {
    const p = open();
    dlg().querySelector('[data-overlap-confirm]').click();
    expect(await p).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it('Cancel, the close button and the backdrop all resolve false', async () => {
    for (const sel of ['.sa-overlap-actions [data-overlap-cancel]', '.sa-modal-close-btn', '[data-overlap-dismiss]']) {
      const p = open();
      dlg().querySelector(sel).click();
      expect(await p).toBe(false);
      document.querySelectorAll('.sa-overlap-modal').forEach((n) => n.remove());
    }
  });

  it('Esc cancels, returns focus, and is not seen by anything underneath', async () => {
    const under = vi.fn();
    document.addEventListener('keydown', under); // bubble phase, like the modal beneath
    const p = open();
    press('Escape');
    expect(await p).toBe(false);
    expect(under).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    document.removeEventListener('keydown', under);
  });

  it('traps Tab: last -> first, and Shift+Tab first -> last', () => {
    open();
    const items = Array.from(dlg().querySelectorAll('button'));
    items[items.length - 1].focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(press('Tab', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it('only ever shows one dialog: a second request while open shares it', async () => {
    const a = open();
    const b = open();
    expect(a).toBe(b);
    expect(document.querySelectorAll('.sa-overlap-modal')).toHaveLength(1);
    dlg().querySelector('[data-overlap-confirm]').click();
    expect(await a).toBe(true);
  });

  it('stops listening once closed', async () => {
    const p = open();
    press('Escape');
    await p;
    const e = press('Escape');
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('describeOverlap wording per action (U1-12)', () => {
  const w = [{ code: 'OVERLAP_BOOKED', with: { className: 'Ride 45', gymId: 'psycle-london', eventId: '1', startAt: '2026-10-05T18:00:00Z' }, crossGym: true }];

  it('defaults to the auto-book wording (U1-6 unchanged)', () => {
    const d = describeOverlap(w);
    expect(d.confirmLabel).toBe('Auto-book anyway');
    expect(d.newLabel).toBe('New auto-book');
    expect(d.lead).toMatch(/Auto-book will try to book both/);
  });

  it('book / quickbook talk about booking, not auto-book', () => {
    const b = describeOverlap(w, 'book');
    expect(b.confirmLabel).toBe('Book anyway');
    expect(b.newLabel).toBe('New booking');
    expect(b.lead).not.toMatch(/Auto-book/);
    expect(describeOverlap(w, 'quickbook').confirmLabel).toBe('Quick-Book anyway');
    expect(b.clashes).toHaveLength(1);
  });
});
