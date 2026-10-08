import { afterEach, describe, expect, it } from 'vitest';
import { assertMutationNetworkAvailable, isMutationMethod } from './network-write-guard.js';

afterEach(() => document.documentElement.classList.remove('app-offline'));

describe('network write guard', () => {
  it('recognises every unsafe HTTP method', () => {
    ['POST', 'PUT', 'PATCH', 'DELETE'].forEach((method) => expect(isMutationMethod(method)).toBe(true));
    expect(isMutationMethod('GET')).toBe(false);
  });

  it('blocks writes when the app has confirmed offline state, while leaving reads available', () => {
    document.documentElement.classList.add('app-offline');
    expect(() => assertMutationNetworkAvailable('POST', 'Reconnect first')).toThrow('Reconnect first');
    expect(() => assertMutationNetworkAvailable('GET', 'Reconnect first')).not.toThrow();
  });
});
