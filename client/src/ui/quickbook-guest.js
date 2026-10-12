// Quick-Book named-guest step. The primary booking is already durable when this
// runs, so a guest failure is reported as a split outcome and never retried or
// rolled back.
export async function bookGuestAfterPrimary({ guest, bookGuest, eventId, slotId = null, gymId }) {
  if (!guest) return { attempted: false, ok: true };
  try {
    const result = await bookGuest(eventId, slotId, guest.email, gymId);
    if (result?.ok) return { attempted: true, ok: true, result };
    return { attempted: true, ok: false, message: result?.error || 'Your guest could not be booked.' };
  } catch (error) {
    return { attempted: true, ok: false, message: error.message || 'Your guest could not be booked.' };
  }
}
