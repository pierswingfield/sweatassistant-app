import { describe, expect, it } from 'vitest';
import { cleanFirstName, inferFirstName, welcomeText, greetingPhrase, greetingText } from './name-capture.js';

describe('Home name capture', () => {
  it('uses one shared gym-profile first-name suggestion, case-insensitively', () => {
    expect(inferFirstName([{ display_name: ' Ada Lovelace ' }, { displayName: 'ada Byron' }])).toBe('Ada');
  });

  it('requires direct entry when linked gym profiles conflict or have no names', () => {
    expect(inferFirstName([{ display_name: 'Ada Lovelace' }, { display_name: 'Grace Hopper' }])).toBe('');
    expect(inferFirstName([{ gym_id: 'one' }, { display_name: '   ' }])).toBe('');
  });

  it('renders a first name only and retains the nameless welcome fallback', () => {
    expect(cleanFirstName(' Ada Lovelace ')).toBe('Ada');
    expect(welcomeText(' Ada Lovelace ')).toBe('Welcome, Ada!');
    expect(welcomeText()).toBe('Welcome!');
  });
});

describe('time-of-day greeting', () => {
  it('switches at 05:00, 12:00 and 18:00 local', () => {
    const at = (h) => greetingPhrase(h);
    expect([at(4), at(5), at(11), at(12), at(17), at(18), at(23), at(0)]).toEqual([
      'Good evening', 'Good morning', 'Good morning', 'Good afternoon', 'Good afternoon', 'Good evening', 'Good evening', 'Good evening',
    ]);
  });
  it('is one line, with or without a name', () => {
    expect(greetingText(' Piers Wingfield ', new Date(2026, 9, 25, 9, 30))).toBe('Good morning, Piers!');
    expect(greetingText('', new Date(2026, 9, 25, 14, 0))).toBe('Good afternoon!');
    expect(greetingText(undefined, new Date(2026, 9, 25, 4, 59))).toBe('Good evening!');
  });
});
