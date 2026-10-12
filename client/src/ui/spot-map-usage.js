// Pure copy for the "remove spot map" confirmation. Counts come from
// GET /api/studio-preferences/:id/usage (this gym + studio, pending/active only).
export function mapRemovalWarning(usage) {
  const ab = Number(usage?.autoBooks) || 0;
  const au = Number(usage?.autoUpgrades) || 0;
  if (!ab && !au) return '';
  const parts = [];
  if (ab) parts.push(`${ab} Auto-Book${ab === 1 ? '' : 's'}`);
  if (au) parts.push(`${au} Auto-Upgrade${au === 1 ? '' : 's'}`);
  const total = ab + au;
  const tail = ab && au
    ? 'Auto-Books will book any spot or skip, and Auto-Upgrades will stop.'
    : ab ? `${total === 1 ? 'It' : 'They'} will book any spot (or skip) without a map.` : `${total === 1 ? 'It' : 'They'} will stop without a map.`;
  return `${parts.join(' and ')} ${total === 1 ? 'uses' : 'use'} this map. ${tail}`;
}

// Kept for callers/tests that want the full text including the confirmation line.
export function mapRemovalMessage(usage, base = 'Confirm remove?') {
  const w = mapRemovalWarning(usage);
  return w ? `${w}\n\n${base}` : base;
}
