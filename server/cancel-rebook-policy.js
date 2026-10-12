// Cancel-and-rebook upgrade policy ([Claude 2026-10-11] user decision).
//
// A gym without a direct spot swap (capabilities.atomicSwap false; today CodexFit/
// Psycle) can only upgrade a member who has NO spare credit by cancelling the
// current spot and booking the better one. That is allowed ONLY when every
// condition below holds; otherwise the cycle is skipped and nothing moves.
// Pure: no I/O, so poller.js and the tests share one definition.

// THE single place to flip the default (per-gym setting `autoUpgradeCancelRebook`
// is GYM-scoped: it is deliberately not in db.js ACCOUNT_SCOPED_SETTING_KEYS).
const CANCEL_REBOOK_DEFAULT = true;
const MIN_FREE_SPOTS = 3;     // unbooked spots in the class right now
const CUTOFF_HOURS = 12;      // the gym's existing upgrade cutoff

// `gymCfg` (gyms.config.js entry): the per-gym capability `cancelRebookUpgrade` must be true,
// whatever the stored setting says. Omitted gymCfg = judge the setting alone (pure callers).
function cancelRebookEnabled(settings, gymCfg) {
  if (gymCfg !== undefined && !(gymCfg && gymCfg.capabilities && gymCfg.capabilities.cancelRebookUpgrade === true)) return false;
  const v = settings && settings.autoUpgradeCancelRebook;
  return typeof v === 'boolean' ? v : CANCEL_REBOOK_DEFAULT;
}

// Provider cancel-penalty answer must positively say "none".
function penaltyIsNone(pen) {
  return !!pen && pen.isPenalty === false && (pen.penalty == null || pen.penalty === 'none');
}

/**
 * @param {{enabled:boolean, atomic:boolean, bookFirstPossible:boolean, freeSpots:number,
 *          hoursUntilClass:number, isCutoffMode:boolean, penaltyNone:boolean}} i
 * @returns {{allowed:boolean, reason?:string}}
 */
function evaluateCancelRebook(i) {
  if (i.atomic) return { allowed: false, reason: 'atomic' };            // never needed
  if (i.bookFirstPossible) return { allowed: false, reason: 'book-first' }; // spare credit: book first instead
  if (!i.enabled) return { allowed: false, reason: 'setting-off' };
  if (i.isCutoffMode || !(i.hoursUntilClass > CUTOFF_HOURS)) return { allowed: false, reason: 'cutoff' };
  if (!(i.freeSpots >= MIN_FREE_SPOTS)) return { allowed: false, reason: 'few-spots' };
  if (i.penaltyNone !== true) return { allowed: false, reason: 'penalty' };
  return { allowed: true };
}

const SKIP_MESSAGES = {
  'setting-off': 'No spare credit and cancel & rebook is off for this gym. Monitoring...',
  cutoff: 'Too close to the class for a cancel & rebook upgrade. Monitoring...',
  'few-spots': 'Fewer than 3 free spots, so a cancel & rebook upgrade was skipped. Monitoring...',
  penalty: 'A cancel & rebook upgrade would risk a cancellation penalty, so it was skipped. Monitoring...',
};

module.exports = { CANCEL_REBOOK_DEFAULT, MIN_FREE_SPOTS, CUTOFF_HOURS, cancelRebookEnabled, penaltyIsNone, evaluateCancelRebook, SKIP_MESSAGES };
