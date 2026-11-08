// Home widget placement rules that depend on a widget's outcome (widget-registry.js
// orderFor). Pure and tiny, so Home can import it without pulling in a lazy widget's code.

/** Static places of the Home widgets that have a placement rule. */
export const HOME_TEAMS_ORDER = 30;      // right after Upcoming (order 20)
export const HOME_ORDER_LAST = 1000;     // below every registered Home widget (they top out at 80)

/**
 * Owner, 2026-11-06: a member of no Team still sees the "Create a Team" card, but BELOW all
 * the other Home widgets; a member of one or more Teams keeps the widget at its place.
 * While loading (or after an error) the last known answer decides, so the card does not
 * jump on every visit; with no answer yet it takes its normal place.
 * @param {'loading'|'ready'|'empty'|'hidden'|'error'} outcome
 * @param {boolean} [wasEmpty]  the last outcome seen was 'empty'
 */
export function homeTeamsOrderFor(outcome, wasEmpty = false) {
  if (outcome === 'empty') return HOME_ORDER_LAST;
  if (outcome === 'ready') return HOME_TEAMS_ORDER;
  return wasEmpty ? HOME_ORDER_LAST : HOME_TEAMS_ORDER;
}
