const { getGymConfig } = require('./gyms.config');

/** Compose a textual spot label from provider label + configured section alias. */
function formatSpotLabel(gymId, label, section) {
  const text = label == null ? '' : String(label);
  if (!section) return text;
  const prefixes = getGymConfig(gymId)?.spotSectionPrefixes || {};
  const alias = Object.entries(prefixes).find(([name]) => name.toLowerCase() === String(section).toLowerCase())?.[1];
  const alreadyPrefixed = alias && text.toLowerCase().startsWith(String(alias).toLowerCase())
    && /^\s*\d+$/.test(text.slice(String(alias).length));
  if (!alias || alreadyPrefixed) return text;
  return `${alias} ${text}`;
}

module.exports = { formatSpotLabel };
