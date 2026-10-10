// Pure, intent-driven wording for the booking flows. "Intent" is the explicit
// flow mode ('autobook' | 'quickbook' | ...), never inferred from bookability.
import { COPY, formatCopyText } from '../copy.js';

/** Label of step 2 ("is-upcoming" / current step) in the Your spots -> Book stepper. */
export function bookStepLabel(intent) {
  return intent === 'autobook' ? COPY.bookingFlow.stepAutoBook : COPY.spotSetup.stepBook;
}

/** Preferred-map summary overlay sentence; singular for exactly one spot. */
export function preferredSummaryText(intent, count, appName) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  if (intent === 'autobook') {
    return formatCopyText(n === 1 ? COPY.bookingFlow.autoBookSummaryOne : COPY.bookingFlow.autoBookSummary, { appName: appName || '', count: n });
  }
  return formatCopyText(n === 1 ? COPY.bookingFlow.quickBookSummaryOne : COPY.bookingFlow.quickBookSummary, { count: n });
}

/** Credit shortfall warning for Auto-Book; '' when nothing is missing. */
export function autoBookCreditWarning(shortfall) {
  const n = Math.ceil(Number(shortfall));
  if (!Number.isFinite(n) || n <= 0) return '';
  return formatCopyText(n === 1 ? COPY.timetable.autoBookCreditShortfallOne : COPY.timetable.autoBookCreditShortfall, { count: n });
}
