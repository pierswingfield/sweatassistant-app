// Gym-local timezone resolution (pure, platform- and gym-agnostic).
//
// Precedence: config per-location override -> zone the provider PUBLISHES
// (MarianaTek: class.location.timezone) -> the gym's default `timezone`.
// CodexFit publishes no zone anywhere, so it resolves from config alone.
// Junk (non-IANA) values at any tier are skipped, never thrown on.

const { DateTime } = require('luxon');

function isValidZone(z) {
  if (typeof z !== 'string' || !z) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: z }); return true; } catch { return false; }
}

/**
 * @param {{timezone?:string, locationTimezones?:Object<string,string>}} gym
 * @param {{providerZone?:string, locationId?:string|number}} [hint]
 * @returns {string} IANA zone
 */
function resolveZone(gym, hint = {}) {
  const g = gym || {};
  const lid = hint.locationId != null ? String(hint.locationId) : null;
  const override = lid && g.locationTimezones ? g.locationTimezones[lid] : null;
  if (isValidZone(override)) return override;
  if (isValidZone(hint.providerZone)) return hint.providerZone;
  if (isValidZone(g.timezone)) return g.timezone;
  return 'UTC';
}

/** Offset-bearing ISO in `zone`. Naive input is read AS `zone`; offset/Z input is converted. */
function toZonedISO(value, zone) {
  if (!value) return undefined;
  const dt = DateTime.fromISO(String(value), { zone });
  return dt.isValid ? dt.toISO({ suppressMilliseconds: true }) : value;
}

/** Zone for a gym id (config only; background rows carry gym_id, never rely on the active gym). */
function zoneOfGym(gymId, locationId) {
  const { getGymConfig } = require('../gyms.config');
  return resolveZone(getGymConfig(gymId), { locationId });
}

module.exports = { zoneOfGym, resolveZone, isValidZone, toZonedISO };
