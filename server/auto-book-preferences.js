function preferenceError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeGuest(raw) {
  const email = String(raw?.email || raw?.guestEmail || '').trim().toLowerCase();
  const name = String(raw?.name || raw?.guestName || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw preferenceError('INVALID_GUEST_EMAIL', 'Each guest needs a valid email address.');
  }
  return { email, name: name || null };
}

function normalizeAutoBookPreferences(preferences = {}) {
  const guests = Array.isArray(preferences.guests) ? preferences.guests.map(normalizeGuest) : [];
  const emails = new Set();
  guests.forEach(({ email }) => {
    if (emails.has(email)) throw preferenceError('DUPLICATE_GUEST_EMAIL', 'Each scheduled guest needs a different email address.');
    emails.add(email);
  });
  // Existing self-only queues retain their count. A named guest is an
  // additional attendee, never a second self-reservation.
  const requestedCount = Math.max(1, Number(preferences.requiredCount) || 1);
  const requiredCount = guests.length ? guests.length + 1 : requestedCount;
  if (guests.length && requestedCount !== requiredCount) {
    throw preferenceError('PARTICIPANT_COUNT_MISMATCH', 'The total places must equal you plus the named guests.');
  }
  if (guests.length > 1) {
    throw preferenceError('GUEST_LIMIT_EXCEEDED', 'This scheduled guest flow currently supports one named guest per class.');
  }
  const prioritizeTogether = requiredCount > 1 && preferences.prioritizeTogether === true;
  return {
    ...preferences,
    guests,
    requiredCount,
    selfCount: guests.length ? 1 : requiredCount,
    // Togetherness needs fallback candidates to fulfil its stated wider search.
    bookAny: prioritizeTogether ? true : preferences.bookAny !== false,
    prioritizeTogether,
  };
}

function participantsForPreferences(preferences) {
  return [
    { participantKey: 'self', participantType: 'self', guestEmail: null, guestName: null },
    ...(preferences.guests || []).map((guest) => ({
      participantKey: `guest:${guest.email}`,
      participantType: 'guest',
      guestEmail: guest.email,
      guestName: guest.name || null,
    })),
  ];
}

module.exports = { normalizeAutoBookPreferences, participantsForPreferences, preferenceError };
