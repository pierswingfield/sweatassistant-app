// U4-7: keep the reader's place across a re-render that swaps the rows.
// Anchor = the first `tr[data-event-id]` whose bottom is below the container's
// top edge, plus how far its top sits from that edge. After the re-render the
// same row (matched by gym + event id: provider ids collide across gyms) is put
// back at the same offset. Falls back to the raw scrollTop.

const rowKey = (el) => `${el.getAttribute('data-gym') || ''}::${el.getAttribute('data-event-id') || ''}`;

const topOf = (el) => (el === document.documentElement || el === document.scrollingElement || el === document.body ? 0 : el.getBoundingClientRect().top);

export function captureScrollAnchor(container, root = container) {
  if (!container) return null;
  const top = container.scrollTop;
  if (top <= 0) return { top: 0, key: null, offset: 0 }; // at the top: nothing to hold
  const cTop = topOf(container);
  const rows = (root || container).querySelectorAll('tr[data-event-id]');
  for (const r of rows) {
    const rect = r.getBoundingClientRect();
    if (rect.bottom > cTop) return { top, key: rowKey(r), offset: rect.top - cTop };
  }
  return { top, key: null, offset: 0 };
}

export function restoreScrollAnchor(container, anchor, root = container) {
  if (!container || !anchor) return;
  if (anchor.key) {
    const cTop = topOf(container);
    for (const r of (root || container).querySelectorAll('tr[data-event-id]')) {
      if (rowKey(r) === anchor.key) {
        container.scrollTop += (r.getBoundingClientRect().top - cTop) - anchor.offset;
        return;
      }
    }
  }
  container.scrollTop = anchor.top;
}
