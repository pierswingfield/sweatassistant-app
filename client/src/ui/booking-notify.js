// U1-16 — the booking-success push payload, built from the NORMALIZED event.
//
// quickBookClass used to read `event.raw` (`eventData.name`, `.discipline`,
// `.instructors[0].name`, `.startAt`). For JAB `.raw` happens to carry those
// names; for Psycle `.raw` is the CodexFit event, which has `event_type`,
// `instructor`, `start_datetime` and none of them, so the push went out with
// no class, no group and no instructor: "CLASS with your instructor - Spot 5".
// One builder over the normalized shape, so no caller can re-open that gap.

export function bookingNotifyPayload(event, { source = 'manual', slots = [], gymId = null } = {}) {
  const e = event || {};
  return {
    source,
    eventId: e.id,
    gymId: gymId || e.gymId || null,
    className: e.name || '',
    groupName: e.discipline || '',
    instructorName: e.instructors?.[0]?.name || '',
    startAt: e.startAt || '',
    slots,
  };
}
