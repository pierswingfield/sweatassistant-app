// Toasts for a finished (or refused) Auto-Book queue request. Pure so the outcomes are testable.
import { COPY, formatCopyText } from '../copy.js';
import { autoBookCreditWarning } from './booking-copy.js';

/** Success first, then every server warning, the credit shortfall and any guest-eligibility note. */
export function autoBookOutcomeToasts({ className, warnings = [], shortfall = 0, guestWarning = null } = {}) {
  const toasts = [{ type: 'success', text: formatCopyText(COPY.timetable.autoBookScheduled, { className }) }];
  for (const w of warnings || []) {
    const text = typeof w === 'string' ? w : w && w.message;
    if (text) toasts.push({ type: 'warning', text });
  }
  const credit = autoBookCreditWarning(shortfall);
  if (credit) toasts.push({ type: 'warning', text: credit });
  if (guestWarning) toasts.push({ type: 'warning', text: String(guestWarning) });
  return toasts;
}

/** A refusal (409 DUPLICATE_AUTO_BOOK, quota, ...) is always an error toast. */
export function autoBookFailureToast(err) {
  return { type: 'error', text: formatCopyText(COPY.timetable.autoBookScheduleFailed, { error: (err && err.message) || '' }) };
}
