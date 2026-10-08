import { describe, expect, it } from 'vitest';
import { cleanFirstName, inferFirstName, welcomeText } from './name-capture.js';

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
