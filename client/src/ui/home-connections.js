import { COPY } from '../copy.js';
import { escapeHtml, gymSquareChip } from './cards.js';

const unavailable = (ctx) => (ctx.allGyms || []).filter(gym => ['needs_relogin', 'syncing'].includes(gym.status));

// A normal Home widget: no provider request, and no warning banner or second card recipe.
export const homeConnectionsWidget = {
  id: 'connections', order: 10, title: 'Gym connections',
  isVisible: (ctx) => unavailable(ctx).length > 0,
  load: (ctx) => unavailable(ctx),
  render(el, gyms) {
    el.innerHTML = `<ul class="home-connections-list">${gyms.map(gym => {
      const name = gym.gym_name || gym.name || gym.gym_id;
      const needsLogin = gym.status === 'needs_relogin';
      return `<li class="home-connection-row"><span class="home-connection-mark" aria-hidden="true">${gymSquareChip(gym.gym_id)}</span><span><strong class="home-connection-name">${escapeHtml(name)}</strong><span class="home-connection-status">${needsLogin ? COPY.gymSettings.loginNeeded : 'Syncing…'}</span></span>${needsLogin ? `<button type="button" class="app-btn-mini home-connection-action" data-reconnect-gym="${escapeHtml(gym.gym_id)}" aria-label="Log in again to ${escapeHtml(name)}">Log in again</button>` : ''}</li>`;
    }).join('')}</ul>`;
    el.querySelectorAll('[data-reconnect-gym]').forEach(button => {
      button.addEventListener('click', async () => {
        const { openLinkGymModal } = await import('./settings.js');
        const gym = gyms.find(item => item.gym_id === button.dataset.reconnectGym);
        openLinkGymModal(gym.gym_id, gym);
      });
    });
    const reconnect = new URLSearchParams(location.search).get('reconnect');
    const button = [...el.querySelectorAll('[data-reconnect-gym]')].find(item => item.dataset.reconnectGym === reconnect);
    if (button) {
      const url = new URL(location.href);
      url.searchParams.delete('reconnect');
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
      queueMicrotask(() => button.click());
    }
  },
};
