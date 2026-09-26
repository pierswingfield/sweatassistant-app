// C1-1: the event debug modal must never render a raw token/key/password/email/
// payment field verbatim, whatever a gym's raw payload happens to contain this
// week. redactSensitivePayload() is the pure function that guarantees it —
// tested in isolation from the DOM modal that calls it.

import { describe, it, expect } from 'vitest';
import { redactSensitivePayload } from './redact.js';

describe('redactSensitivePayload', () => {
  it('redacts a top-level access token', () => {
    const out = redactSensitivePayload({ access_token: 'abc.def.ghi', eventId: '123' });
    expect(out.access_token).toBe('[redacted]');
    expect(out.eventId).toBe('123');
  });

  it('redacts nested and camelCase/snake_case key variants', () => {
    const out = redactSensitivePayload({
      raw: {
        user: { email: 'member@example.com', apiKey: 'sk_live_xyz' },
        card_number: '4242424242424242',
        cvv: '123',
      },
    });
    expect(out.raw.user.email).toBe('[redacted]');
    expect(out.raw.user.apiKey).toBe('[redacted]');
    expect(out.raw.card_number).toBe('[redacted]');
    expect(out.raw.cvv).toBe('[redacted]');
  });

  it('redacts inside arrays of objects', () => {
    const out = redactSensitivePayload({
      payment_methods: [
        { id: 'pm_1', last4: '4242', password: 'should-not-happen' },
      ],
    });
    expect(out.payment_methods[0].id).toBe('pm_1');
    expect(out.payment_methods[0].last4).toBe('[redacted]');
    expect(out.payment_methods[0].password).toBe('[redacted]');
  });

  it('leaves non-sensitive fields, including gym-domain fields that merely contain a near-miss substring, untouched', () => {
    const out = redactSensitivePayload({
      studioId: '138',
      classTypeId: '9',
      // A real MarianaTek field name (see AGENTS.md) — must not be swept up by
      // an over-broad "session" match.
      class_session_type: 'Boxing',
      discipline: 'Ride',
      capacity: 20,
    });
    expect(out).toEqual({
      studioId: '138',
      classTypeId: '9',
      class_session_type: 'Boxing',
      discipline: 'Ride',
      capacity: 20,
    });
  });

  it('preserves null/undefined sensitive values instead of stringifying them', () => {
    const out = redactSensitivePayload({ email: null, token: undefined });
    expect(out.email).toBe(null);
    expect(out.token).toBe(undefined);
  });

  it('handles circular references without throwing', () => {
    const obj = { name: 'evt' };
    obj.self = obj;
    expect(() => redactSensitivePayload(obj)).not.toThrow();
    expect(redactSensitivePayload(obj).self).toBe('[circular]');
  });

  it('does not mutate the input', () => {
    const input = { token: 'secret-value' };
    redactSensitivePayload(input);
    expect(input.token).toBe('secret-value');
  });
});
