// Quick-Book tap flow, pure so it can be tested without the DOM.
//
// A tap on the row's Quick Book button does ONE of:
//   - armed (a clean first tap already happened): run now. No second overlap check.
//   - not armed: ask the overlap gate.
//       'acknowledged' -> the member just confirmed a modal, so book straight on
//                         (no extra row confirm: the modal already guards it).
//       'clear'        -> nothing to warn about; arm the two-tap confirm.
//       false          -> member backed out; nothing happens, nothing stays armed.
// A tap while a flow is in progress (modal open, request in flight) is ignored.
export async function quickBookTap({ armed, busy, gate, arm, run }) {
  if (busy) return 'ignored';
  if (armed) { arm(); return 'confirmed'; } // arm() on an armed button runs it
  const outcome = await gate();
  if (!outcome) return 'cancelled';
  if (outcome === 'acknowledged') { await run({ overlapAcknowledged: true }); return 'ran'; }
  arm();
  return 'armed';
}
