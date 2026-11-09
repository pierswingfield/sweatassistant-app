import { describe, it, expect } from 'vitest';
import { homeConnectionsWidget } from './home-connections.js';
import { mountWidget } from './widget-registry.js';

const link = (gym_id, status = 'needs_relogin') => ({ gym_id, status, gym_name: `${gym_id} Studio` });

describe('Home gym connections', () => {
  it('keeps a distinct accessible reconnect action for each unavailable gym', async () => {
    const ctx = { allGyms: [link('first'), link('healthy', 'active'), link('second'), link('pending', 'syncing')] };
    const el = document.createElement('section');
    await mountWidget(el, homeConnectionsWidget, ctx);
    expect(el.querySelector('.home-widget-title').textContent).toBe('Gym connections');
    expect(el.querySelectorAll('li')).toHaveLength(3);
    expect([...el.querySelectorAll('button')].map(button => [button.dataset.reconnectGym, button.getAttribute('aria-label')]))
      .toEqual([['first', 'Log in again to first Studio'], ['second', 'Log in again to second Studio']]);
    expect(el.textContent).toContain('Syncing…');
    expect(el.textContent).not.toContain('healthy Studio');
    expect(el.textContent).not.toMatch(/automation|preserved|calendar/i);
  });

  it('is present when all gyms need login, and disappears when they recover', async () => {
    const ctx = { gyms: [], allGyms: [link('first'), link('second')] };
    expect(homeConnectionsWidget.isVisible(ctx)).toBe(true);
    const el = document.createElement('section');
    await mountWidget(el, homeConnectionsWidget, ctx);
    expect(el.querySelectorAll('[data-reconnect-gym]')).toHaveLength(2);
    expect(homeConnectionsWidget.isVisible({ allGyms: ctx.allGyms.map(gym => ({ ...gym, status: 'active' })) })).toBe(false);
    expect(homeConnectionsWidget.isVisible({ allGyms: [] })).toBe(false);
  });

  it('escapes the full gym name in both the row and accessible action', async () => {
    const el = document.createElement('section');
    await mountWidget(el, homeConnectionsWidget, { allGyms: [{ ...link('first'), gym_name: 'A <script> & "Studio"' }] });
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('.home-connection-name').textContent).toBe('A <script> & "Studio"');
    expect(el.querySelector('button').getAttribute('aria-label')).toBe('Log in again to A <script> & "Studio"');
  });
});
