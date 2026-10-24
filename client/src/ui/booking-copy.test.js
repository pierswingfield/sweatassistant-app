import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.js';
import { bookStepLabel, preferredSummaryText, autoBookCreditWarning } from './booking-copy.js';
import { resolveSpotLabels } from './spot-labels.js';

describe('intent-driven wording', () => {
  it('Auto-Book says "Auto-Book class"; other flows keep "Book class"', () => {
    expect(bookStepLabel('autobook')).toBe('Auto-Book class');
    expect(bookStepLabel('quickbook')).toBe('Book class');
    expect(bookStepLabel('other')).toBe('Book class');
    expect(COPY.timetable.scheduleAutoBook).toBe('Auto-Book class');
    expect(COPY.spotSetup.chooseForNow).toBe('Choose a spot for now');
  });
  it('pluralises the summary sentence and uses the configured app name', () => {
    expect(preferredSummaryText('autobook', 1, 'Dibs')).toBe('Dibs will book 1 spot based on your preferred spot map.');
    expect(preferredSummaryText('autobook', 3, 'Acme')).toBe('Acme will book 3 spots based on your preferred spot map.');
    expect(preferredSummaryText('quickbook', 1)).toBe('Quick-Book will book 1 spot based on your preferred spot map.');
    expect(preferredSummaryText('quickbook', 2)).toBe('Quick-Book will book 2 spots based on your preferred spot map.');
  });
  it('credit warning pluralises and is empty when nothing is missing', () => {
    expect(autoBookCreditWarning(1)).toBe('1 more credit is required for Auto-Book to work.');
    expect(autoBookCreditWarning(2)).toBe('2 more credits are required for Auto-Book to work.');
    expect(autoBookCreditWarning(0)).toBe('');
  });
});

describe('spot label resolution', () => {
  const layout = [{ id: 1, label: '5' }, { id: 2, label: '6' }];
  it('returns labels from the layout and counts ids it cannot resolve', () => {
    expect(resolveSpotLabels([1, 37458, 2], layout)).toEqual({ labels: ['5', '6'], unresolved: 1 });
  });
  it('never surfaces a raw id as a label', () => {
    expect(resolveSpotLabels(['37458'], [])).toEqual({ labels: [], unresolved: 1 });
  });
});
