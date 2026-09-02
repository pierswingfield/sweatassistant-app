// Gym context + capability gating (WP-D14).
//
// The failure this guards against is asymmetric, which is why the defaults
// matter as much as the gating: hiding a feature a gym HAS is worse than briefly
// showing one it hasn't, because the first is permanent and silent while the
// second self-corrects the moment the catalogue loads.

import { describe, it, expect, beforeEach } from 'vitest';
import { setGymContext, getGymContext, can, gymLabel, applyCapabilityGates } from './gym-context.js';
import { getDiscipline, trimLocation, seatNoun } from './ui/cards.js';

const PSYCLE = {
  id: 'psycle-london', name: 'Psycle London',
  theme: { key: 'violet', primary: '#7c3aed' },
  labels: { class: 'class', spot: 'spot' },
  capabilities: { atomicSwap: false, nativeWaitlist: false, metered: true, creditPurchase: true, bookmarks: true },
};
const JAB = {
  id: 'jab-boxing', name: 'JAB Boxing Club',
  theme: { key: 'navy', primary: '#18214D', font: 'Gothic A1' },
  labels: { class: 'class', spot: 'spot' },
  capabilities: { atomicSwap: true, nativeWaitlist: true, metered: false, creditPurchase: false, bookmarks: false },
};

describe('capabilities', () => {
  it('reports what the active gym can do', () => {
    setGymContext(JAB);
    expect(can('atomicSwap')).toBe(true);
    expect(can('bookmarks')).toBe(false);
    expect(can('creditPurchase')).toBe(false);
    expect(can('metered')).toBe(false);
  });

  it('switches cleanly between gyms', () => {
    setGymContext(JAB);
    setGymContext(PSYCLE);
    expect(can('bookmarks')).toBe(true);
    expect(can('atomicSwap')).toBe(false);
    expect(getGymContext().name).toBe('Psycle London');
  });

  it('treats a flag the config omits as ENABLED, not disabled', () => {
    // `undefined` is falsy, so a naive read hides a feature the gym actually has
    // — and it stays hidden, silently, forever. Defaulting the other way costs
    // at most a brief flash of something that then hides itself.
    setGymContext({ id: 'x', name: 'Half-configured Gym', capabilities: { atomicSwap: true } });
    expect(can('bookmarks')).toBe(true);
    expect(can('creditPurchase')).toBe(true);
    expect(can('atomicSwap')).toBe(true);
  });

  it('ignores a null gym rather than wiping the context', () => {
    setGymContext(PSYCLE);
    setGymContext(null);
    expect(getGymContext().name).toBe('Psycle London');
  });
});

describe('applyCapabilityGates', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="credits" data-requires-capability="creditPurchase">Buy Credits</button>
      <button id="marks" data-requires-capability="bookmarks">Bookmarked</button>
      <button id="always">Timetable</button>`;
  });

  it('hides only what the gym lacks', () => {
    setGymContext(JAB);
    applyCapabilityGates();
    expect(document.getElementById('credits').hidden).toBe(true);
    expect(document.getElementById('marks').hidden).toBe(true);
    expect(document.getElementById('always').hidden).toBe(false);
  });

  it('un-hides on a switch to a gym that has the feature', () => {
    setGymContext(JAB);
    applyCapabilityGates();
    setGymContext(PSYCLE);
    applyCapabilityGates();
    expect(document.getElementById('credits').hidden).toBe(false);
    expect(document.getElementById('marks').hidden).toBe(false);
  });

  it('uses the hidden attribute, not inline display', () => {
    // An inline `display:none` would have to be undone with the element's
    // ORIGINAL display mode (flex/grid/inline-flex), which the gate doesn't know.
    setGymContext(JAB);
    applyCapabilityGates();
    expect(document.getElementById('credits').style.display).toBe('');
  });
});

describe('theming', () => {
  it('stamps data-gym so CSS can theme by it', () => {
    setGymContext(JAB);
    expect(document.documentElement.getAttribute('data-gym')).toBe('jab-boxing');
    setGymContext(PSYCLE);
    expect(document.documentElement.getAttribute('data-gym')).toBe('psycle-london');
  });

  it('loads a gym font once, and only when one is named', () => {
    document.head.querySelectorAll('#gym-font').forEach((n) => n.remove());
    setGymContext(PSYCLE);
    expect(document.getElementById('gym-font')).toBeNull();
    setGymContext(JAB);
    const link = document.getElementById('gym-font');
    expect(link).not.toBeNull();
    expect(link.href).toContain('Gothic+A1');
    setGymContext(JAB);
    expect(document.querySelectorAll('#gym-font').length).toBe(1);
  });
});

describe('gym-neutral labels', () => {
  it('maps a discipline the gym actually runs', () => {
    expect(getDiscipline('BOXING').key).toBe('boxing');
    expect(getDiscipline('Conditioning').key).toBe('conditioning');
    expect(getDiscipline('Ride').key).toBe('ride');
  });

  it('keeps the gym\'s own wording for anything unrecognised', () => {
    // Better a neutral chip reading "Aerial Hoop" than a wrong one reading "Ride".
    const d = getDiscipline('aerial hoop');
    expect(d.key).toBe('other');
    expect(d.label).toBe('Aerial Hoop');
  });

  it('trims the gym name off a location, and is a no-op without one', () => {
    expect(trimLocation('Psycle Shoreditch', 'Psycle London')).toBe('Shoreditch');
    expect(trimLocation('JAB SW1', 'JAB Boxing Club')).toBe('SW1');
    // No gym name → leave it alone rather than assuming Psycle.
    expect(trimLocation('Psycle Shoreditch')).toBe('Psycle Shoreditch');
    // Never trim to nothing.
    expect(trimLocation('Psycle', 'Psycle London')).toBe('Psycle');
  });

  it('picks the seat noun from the discipline, not the gym', () => {
    expect(seatNoun('Ride')).toBe('bike');
    expect(seatNoun('Cycle')).toBe('bike');
    expect(seatNoun('BOXING')).toBe('spot');
    expect(seatNoun('')).toBe('spot');
  });
});
