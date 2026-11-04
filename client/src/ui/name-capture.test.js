import { describe, expect, it } from 'vitest';
import { cleanFirstName, cleanNameField, gymProfileName, inferFirstName, inferNames, welcomeText, greetingPhrase, greetingText } from './name-capture.js';

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

describe('T-1 first and last name inference (PLAN-teams §5.8)', () => {
  it('prefers the gym profile first_name/last_name over splitting display_name', () => {
    expect(inferNames([{ gym_name: 'Psycle', display_name: 'Mary Ann Smith', first_name: 'Mary Ann', last_name: 'Smith' }]))
      .toEqual({ firstName: 'Mary Ann', lastName: 'Smith', sources: ['Psycle'] });
  });

  it('splits display_name at its first and last words when no name fields exist', () => {
    expect(gymProfileName({ display_name: '  Piers   Wingfield ' })).toEqual({ first: 'Piers', last: 'Wingfield' });
    expect(gymProfileName({ display_name: 'Cher' })).toEqual({ first: 'Cher', last: '' });
    expect(gymProfileName({})).toEqual({ first: '', last: '' });
  });

  it('agrees across gyms case-insensitively and names every source gym', () => {
    const r = inferNames([
      { gym_name: 'Psycle', first_name: 'Ada', last_name: 'Lovelace' },
      { gym_name: 'JAB', display_name: 'ada LOVELACE' },
    ]);
    expect(r).toEqual({ firstName: 'Ada', lastName: 'Lovelace', sources: ['Psycle', 'JAB'] });
  });

  it('a gym without a last name does not contradict one that has it', () => {
    expect(inferNames([{ first_name: 'Ada', last_name: '' }, { first_name: 'Ada', last_name: 'King' }]).lastName).toBe('King');
  });

  it('ambiguous: conflicting first names suggest nothing; conflicting last names keep the first name only', () => {
    expect(inferNames([{ first_name: 'Ada', last_name: 'King' }, { first_name: 'Grace', last_name: 'King' }]))
      .toEqual({ firstName: '', lastName: '', sources: [] });
    expect(inferNames([{ gym_name: 'A', first_name: 'Ada', last_name: 'King' }, { gym_name: 'B', first_name: 'Ada', last_name: 'Lovelace' }]))
      .toEqual({ firstName: 'Ada', lastName: '', sources: ['A', 'B'] });
    expect(inferNames([])).toEqual({ firstName: '', lastName: '', sources: [] });
    expect(inferNames([{ last_name: 'Orphan' }]).firstName).toBe('');
  });

  it('inferFirstName stays a thin wrapper and cleanNameField normalises whitespace', () => {
    expect(inferFirstName([{ first_name: 'Mary Ann', last_name: 'Smith' }])).toBe('Mary Ann');
    expect(cleanNameField('  de   la  Cruz ')).toBe('de la Cruz');
    expect(cleanNameField(null)).toBe('');
  });
});
