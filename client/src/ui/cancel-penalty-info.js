// What cancelling costs, from the provider's own cancel-penalty answer (never from window maths).
// An unknown answer says so plainly and never implies the cancel is free.
import { COPY } from '../copy.js';

/** @returns {{kind:'free'|'penalty'|'unknown', text:string}} */
export function describeCancelPenalty(result) {
  const unknown = { kind: 'unknown', text: COPY.bookings.cancelPenaltyUnknown };
  if (!result) return unknown;
  const level = result.penalty || (typeof result.isPenalty === 'boolean' ? (result.isPenalty ? 'credit' : 'none') : 'unknown');
  if (level === 'none') {
    const text = result.deadline ? COPY.bookings.cancelFreeUntil.replace('{deadline}', result.deadline) : COPY.bookings.cancelFree;
    return { kind: 'free', text };
  }
  if (level !== 'credit' && level !== 'fee') return unknown;
  const message = result.message ? String(result.message).trim() : '';
  const deadline = result.deadline ? ` ${COPY.bookings.cancelDeadline.replace('{deadline}', result.deadline)}` : '';
  return { kind: 'penalty', text: `${COPY.bookings.cancelPenaltyApplies}${message ? ` ${message}` : ''}${deadline}` };
}

/** Never throws; a failed check is "unknown". */
export async function loadCancelInfo(api, bookingId, gymId) {
  try { return describeCancelPenalty(await api.getCancelPenalty(bookingId, gymId)); }
  catch (_) { return describeCancelPenalty(null); }
}
