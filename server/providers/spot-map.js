'use strict';
// Spot-map policy: which of a gym's studios offer the whole-row preference
// ("row group" selector, `preferredRows`) in the preferred-spot-map editor.
//
// It is POLICY, so it is declared per gym in gyms.config.js and never inferred
// from a platform. Default is OFF: a studio only has row groups when the gym
// config names it. Config shape (all optional):
//
//   spotMap: { rowGroupStudios: { ids: ['108'], namePattern: '^ride' } }
//
// `ids` are provider studio ids (compared as strings). `namePattern` is a
// case-insensitive regex source matched against the studio name, for gyms whose
// studio ids are not stable/known up front (ride rooms stagger their rows).
// This module knows no gym; adapters pass their own config in.

/** @returns {boolean} true only when the gym config flags this studio. */
function studioHasRowGroups(gym, studio) {
  const cfg = gym && gym.spotMap && gym.spotMap.rowGroupStudios;
  if (!cfg || !studio) return false;
  if (Array.isArray(cfg.ids) && studio.id != null && cfg.ids.map(String).includes(String(studio.id))) return true;
  if (cfg.namePattern && studio.name) {
    try { return new RegExp(cfg.namePattern, 'i').test(String(studio.name)); } catch (_) { return false; }
  }
  return false;
}

module.exports = { studioHasRowGroups };
