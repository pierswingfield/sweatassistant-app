// Candidate retries are safe only when the provider confirms that this one
// spot lost a race. Duplicate bookings, timeouts and payment/auth failures are
// terminal: retrying another spot can create a second reservation or hide the
// actionable error.
export function isRetryableSpotFailure(result) {
  if (!result || result.ok) return false;
  if (result.code === 'SPOT_UNAVAILABLE') return true;
  if (result.code === 'ALREADY_BOOKED' || result.code === 'BOOKING_TIMEOUT') return false;
  const message = String(result.error || result.message || '').toLowerCase();
  if (/already\s+(?:have|booked|reserved)|duplicate\s+(?:booking|reservation)/.test(message)) return false;
  return Number(result.status) === 409 && /(?:spot|seat|slot).*(?:unavailable|taken|no longer available)/.test(message);
}

export async function bookCandidateSpots({ candidates, requiredCount = 1, book, retryDelayMs = 1500, timeoutMs = 20_000 }) {
  const booked = [];
  let terminalError = null;
  const deadline = Date.now() + timeoutMs;
  for (let i = 0; i < candidates.length && booked.length < requiredCount; i++) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      terminalError = { ok: false, code: 'BOOKING_TIMEOUT', error: 'Booking timed out. Check My Bookings before trying again.' };
      break;
    }
    const slotId = candidates[i];
    let result;
    try {
      result = await book(slotId, { timeoutMs: remainingMs });
    } catch (err) {
      result = { ok: false, error: err.message, code: err.code, status: err.status };
    }
    if (result?.ok) {
      booked.push({ slotId, result });
      continue;
    }
    terminalError = result || { ok: false, error: 'Booking was declined.' };
    if (!isRetryableSpotFailure(terminalError) || i === candidates.length - 1) break;
    if (deadline - Date.now() <= retryDelayMs) {
      terminalError = { ok: false, code: 'BOOKING_TIMEOUT', error: 'Booking timed out. Check My Bookings before trying again.' };
      break;
    }
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  return { booked, terminalError: booked.length >= requiredCount ? null : terminalError };
}
