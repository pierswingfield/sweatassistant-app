// Gym context + capability gating (WP-D14).
//
// The failure this guards against is asymmetric, which is why the defaults
// matter as much as the gating: hiding a feature a gym HAS is worse than briefly
// showing one it hasn't, because the first is permanent and silent while the
// second self-corrects the moment the catalogue loads.
//
// C3-6: this used to test an ambient module-level `state` via
// `setGymContext()`/`getGymContext()`/`can()` — ONE gym the whole module
// defaulted to. That was the client twin of the server-side "active gym" bug
// class removed 2026-09-16: on a multi-gym account, anything reading it got a
// guess. It's gone; every capability read here now names its gym explicitly
// via `canForGym`/`capabilityForGym`, or (for the "any linked gym" global-chrome
// gates) via the linked-gyms list `setLinkedGyms()` seeds.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setLinkedGyms, getLinkedGyms, canForGym, capabilityForGym, canAny,
  applyCapabilityGates, applyGymFonts, applyGymNames,
} from './gym-context.js';
import { getDiscipline, trimLocation, seatNoun } from './ui/cards.js';

const PSYCLE = {
  gym_id: 'psycle-london', id: 'psycle-london', name: 'Psycle London', shortName: 'Psycle',
  theme: { key: 'violet', primary: '#7c3aed' },
  labels: { class: 'class', spot: 'spot' },
  capabilities: { atomicSwap: false, nativeWaitlist: false, metered: true, creditPurchase: true, bookmarks: true },
};
const JAB = {
  gym_id: 'jab-boxing', id: 'jab-boxing', name: 'JAB Boxing Club', shortName: 'JAB',
  theme: { key: 'navy', primary: '#18214D', font: 'Gothic A1' },
  labels: { class: 'class', spot: 'spot' },
  capabilities: { atomicSwap: true, nativeWaitlist: true, metered: false, creditPurchase: false, bookmarks: false },
};

beforeEach(() => {
  setLinkedGyms([]);
  document.head.querySelectorAll('[id^="gym-font-"]').forEach((n) => n.remove());
  document.querySelectorAll('[data-gym-name]').forEach((el) => { el.textContent = 'your gym'; });
});

describe('per-gym capabilities (canForGym)', () => {
  it('reports what a SPECIFIC linked gym can do, not a guessed default', () => {
    setLinkedGyms([JAB, PSYCLE]);
    expect(canForGym('atomicSwap', 'jab-boxing')).toBe(true);
    expect(canForGym('bookmarks', 'jab-boxing')).toBe(false);
    expect(canForGym('creditPurchase', 'jab-boxing')).toBe(false);
    expect(canForGym('metered', 'jab-boxing')).toBe(false);
    expect(canForGym('bookmarks', 'psycle-london')).toBe(true);
    expect(canForGym('atomicSwap', 'psycle-london')).toBe(false);
  });

  it('treats a flag the config omits as ENABLED, not disabled', () => {
    // `undefined` is falsy, so a naive read hides a feature the gym actually has
    // — and it stays hidden, silently, forever. Defaulting the other way costs
    // at most a brief flash of something that then hides itself.
    setLinkedGyms([{ gym_id: 'x', id: 'x', name: 'Half-configured Gym', capabilities: { atomicSwap: true } }]);
    expect(canForGym('bookmarks', 'x')).toBe(true);
    expect(canForGym('creditPurchase', 'x')).toBe(true);
    expect(canForGym('atomicSwap', 'x')).toBe(true);
  });

  it('falls back to the permissive default for a gym this account is not linked to', () => {
    setLinkedGyms([PSYCLE]);
    // Asking about a gym that isn't (yet) in the linked list — e.g. a race
    // between linking and the capability catalogue landing — must not read as
    // "no capabilities", which would hide every feature.
    expect(canForGym('bookmarks', 'some-other-gym')).toBe(true);
    // atomicSwap's own default is OFF (CodexFit-shaped: no gym is assumed to
    // have it) — the permissive default is per-flag, not "always true".
    expect(canForGym('atomicSwap', 'some-other-gym')).toBe(false);
  });

  it('with no gymId at all, answers permissively rather than guessing which gym', () => {
    setLinkedGyms([JAB]);
    // No ambient "the active gym" to fall back to any more — omitting gymId is
    // the same as asking about an unknown gym.
    expect(canForGym('bookmarks')).toBe(true);
  });
});

describe('capabilityForGym (raw, non-boolean values)', () => {
  it('reads a per-gym raw flag like maxSpotsPerClass without !! coercion', () => {
    setLinkedGyms([
      { gym_id: 'jab-boxing', id: 'jab-boxing', capabilities: { maxSpotsPerClass: 1 } },
      { gym_id: 'psycle-london', id: 'psycle-london', capabilities: { maxSpotsPerClass: null } },
    ]);
    expect(capabilityForGym('maxSpotsPerClass', 'jab-boxing')).toBe(1);
    expect(capabilityForGym('maxSpotsPerClass', 'psycle-london')).toBeNull();
  });
});

describe('canAny — global chrome above a merged list', () => {
  it('is true if ANY linked gym has the capability', () => {
    setLinkedGyms([JAB, PSYCLE]);
    expect(canAny('bookmarks')).toBe(true); // Psycle has it, even though JAB doesn't
    expect(canAny('atomicSwap')).toBe(true); // JAB has it, even though Psycle doesn't
  });

  it('is false only when NO linked gym has it', () => {
    setLinkedGyms([JAB]);
    expect(canAny('bookmarks')).toBe(false);
  });

  it('defaults permissive with zero linked gyms', () => {
    setLinkedGyms([]);
    expect(canAny('bookmarks')).toBe(true);
  });
});

describe('applyCapabilityGates', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="credits" data-requires-capability="creditPurchase">Buy Credits</button>
      <button id="marks" data-requires-capability="bookmarks">Bookmarked</button>
      <button id="always">Timetable</button>`;
  });

  it('hides only what NO linked gym has', () => {
    setLinkedGyms([JAB]);
    applyCapabilityGates();
    expect(document.getElementById('credits').hidden).toBe(true);
    expect(document.getElementById('marks').hidden).toBe(true);
    expect(document.getElementById('always').hidden).toBe(false);
  });

  it('un-hides once a gym with the feature is linked too', () => {
    setLinkedGyms([JAB]);
    applyCapabilityGates();
    setLinkedGyms([JAB, PSYCLE]);
    applyCapabilityGates();
    expect(document.getElementById('credits').hidden).toBe(false);
    expect(document.getElementById('marks').hidden).toBe(false);
  });

  it('uses the hidden attribute, not inline display', () => {
    // An inline `display:none` would have to be undone with the element's
    // ORIGINAL display mode (flex/grid/inline-flex), which the gate doesn't know.
    setLinkedGyms([JAB]);
    applyCapabilityGates();
    expect(document.getElementById('credits').style.display).toBe('');
  });
});

describe('theming and copy — fanned out across every linked gym, no single guess', () => {
  it('loads a gym font once per gym, and only when one is named', () => {
    setLinkedGyms([PSYCLE]);
    applyGymFonts();
    expect(document.getElementById('gym-font-psycle-london')).toBeNull();
    setLinkedGyms([PSYCLE, JAB]);
    applyGymFonts();
    const link = document.getElementById('gym-font-jab-boxing');
    expect(link).not.toBeNull();
    expect(link.href).toContain('Gothic+A1');
    applyGymFonts();
    expect(document.querySelectorAll('#gym-font-jab-boxing').length).toBe(1);
  });

  it('names a single linked gym directly', () => {
    document.body.innerHTML = '<span data-gym-name>your gym</span>';
    setLinkedGyms([PSYCLE]);
    expect(document.querySelector('[data-gym-name]').textContent).toBe('Psycle');
  });

  it('joins every linked gym rather than guessing one', () => {
    document.body.innerHTML = '<span data-gym-name>your gym</span>';
    setLinkedGyms([PSYCLE, JAB]);
    expect(document.querySelector('[data-gym-name]').textContent).toBe('Psycle and JAB');
  });

  it('leaves the neutral placeholder with no linked gym yet', () => {
    document.body.innerHTML = '<span data-gym-name>your gym</span>';
    setLinkedGyms([]);
    expect(document.querySelector('[data-gym-name]').textContent).toBe('your gym');
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
