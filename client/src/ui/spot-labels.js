// User-facing spot labels for a saved preference. A raw provider id (for
// example 37458) is never a spot number: an id with no label in the layout is
// omitted from the label list and reported as a count instead.
export function resolveSpotLabels(ids, layoutSlots, { sameId = (a, b) => String(a) === String(b), format = (slot) => slot.label } = {}) {
  const labels = [];
  let unresolved = 0;
  for (const id of ids || []) {
    const slot = (layoutSlots || []).find((s) => sameId(s.id, id));
    const text = slot ? String(format(slot) ?? '').trim() : '';
    if (text) labels.push(text); else unresolved += 1;
  }
  return { labels, unresolved };
}
