// provider factory.
//
// Resolves a gym id → a concrete GymProvider adapter instance. Adapters are
// stateless per user (they take a session per call), so we cache one instance
// per gym id.

const { getGymConfig } = require('../gyms.config');
const CodexFitProvider = require('./codexfit');
const MarianaTekProvider = require('./marianatek');

const ADAPTERS = {
  codexfit: CodexFitProvider,
  marianatek: MarianaTekProvider,
};

const cache = new Map(); // gymId → adapter instance

/**
 * @param {string} gymId
 * @returns {import('./base').GymProvider}
 */
function getProvider(gymId) {
  if (cache.has(gymId)) return cache.get(gymId);

  const gym = getGymConfig(gymId);
  if (!gym) throw new Error(`Unknown gym id: "${gymId}"`);

  const Adapter = ADAPTERS[gym.provider];
  if (!Adapter) throw new Error(`No adapter for provider "${gym.provider}" (gym "${gymId}").`);

  const instance = new Adapter(gym);
  cache.set(gymId, instance);
  return instance;
}

module.exports = { getProvider };
