// What cancelling costs, from the provider's own cancel-penalty answer (never from window maths).
// An unknown answer says so plainly and never implies the cancel is free.
import { COPY } from '../copy.js';

/** @returns {{kind:'free'|'penalty'|'unknown', text:string}} */
export function describeCancelPenalty(result) {
  if (!result || typeof result.isPenalty !== 'boolean') return { kind: 'unknown', text: COPY.bookings.cancelPenaltyUnknown };
  const message = result.message ? String(result.message).trim() : '';
  const lead = result.isPenalty ? COPY.bookings.cancelPenaltyApplies : COPY.bookings.cancelFree;
  const deadline = result.deadline ? ` ${COPY.bookings.cancelDeadline.replace('{deadline}', result.deadline)}` : '';
  return { kind: result.isPenalty ? 'penalty' : 'free', text: `${lead}${message ? ` ${message}` : ''}${deadline}` };
}

/** Never throws; a failed check is "unknown". */
export async function loadCancelInfo(api, bookingId, gymId) {
  try { return describeCancelPenalty(await api.getCancelPenalty(bookingId, gymId)); }
  catch (_) { return describeCancelPenalty(null); }
}
