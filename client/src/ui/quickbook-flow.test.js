import { describe, it, expect, vi } from 'vitest';
import { quickBookTap } from './quickbook-flow.js';

const mk = (o = {}) => ({ armed: false, busy: false, gate: vi.fn(async () => 'clear'), arm: vi.fn(), run: vi.fn(), ...o });

describe('quickBookTap', () => {
  it('overlap acknowledged: runs straight away, no row confirm, gate asked once', async () => {
    const d = mk({ gate: vi.fn(async () => 'acknowledged') });
    expect(await quickBookTap(d)).toBe('ran');
    expect(d.run).toHaveBeenCalledWith({ overlapAcknowledged: true });
    expect(d.arm).not.toHaveBeenCalled();
    expect(d.gate).toHaveBeenCalledTimes(1);
  });
  it('overlap dismissed: nothing runs or arms', async () => {
    const d = mk({ gate: vi.fn(async () => false) });
    expect(await quickBookTap(d)).toBe('cancelled');
    expect(d.run).not.toHaveBeenCalled();
    expect(d.arm).not.toHaveBeenCalled();
  });
  it('clean check: arms the two-tap confirm; second tap does not re-gate', async () => {
    const d = mk();
    expect(await quickBookTap(d)).toBe('armed');
    const d2 = mk({ armed: true });
    expect(await quickBookTap(d2)).toBe('confirmed');
    expect(d2.gate).not.toHaveBeenCalled();
  });
  it('ignores taps while busy', async () => {
    const d = mk({ busy: true });
    expect(await quickBookTap(d)).toBe('ignored');
    expect(d.gate).not.toHaveBeenCalled();
  });
});
