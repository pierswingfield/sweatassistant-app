import { describe, it, expect } from 'vitest';
import { isBenefitUnknown } from './benefit-state.js';
import { membershipHtml } from './gym-settings-section.js';

const metered = { id: 'p', capabilities: { metered: true } };
const member = { id: 'j', capabilities: { metered: false } };

describe('unknown membership/credits renders nothing', () => {
  it('distinguishes unknown from confirmed none', () => {
    expect(isBenefitUnknown(member, undefined, undefined)).toBe(true);
    expect(isBenefitUnknown(member, null, undefined)).toBe(false);
    expect(isBenefitUnknown(metered, null, undefined)).toBe(true);
    expect(isBenefitUnknown(metered, null, [])).toBe(false);
    expect(isBenefitUnknown(member, { name: 'x' }, undefined)).toBe(false);
  });
  it('membershipHtml is blank when unknown, populated when confirmed', () => {
    expect(membershipHtml(metered, null, undefined)).toBe('');
    expect(membershipHtml(member, undefined, undefined)).toBe('');
    expect(membershipHtml(metered, null, [{ count: 0 }])).toContain('0');
  });
});
