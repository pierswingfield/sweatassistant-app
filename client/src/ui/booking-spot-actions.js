import { COPY } from '../copy.js';

/**
 * Actions available from a member's booked spot. The card owns the rendering;
 * this small model keeps capability and monitor-state decisions testable.
 */
export function bookingSpotActions({ canAutoUpgrade, hasActiveUpgrade }) {
  const actions = [
    { id: 'change-spot', label: COPY.bookings.changeSpot },
  ];
  if (canAutoUpgrade) {
    actions.push({
      id: 'auto-upgrade',
      label: hasActiveUpgrade ? COPY.bookings.disableUpgrade : COPY.bookings.enableUpgrade,
    });
  }
  actions.push({ id: 'cancel', label: COPY.bookings.cancel, danger: true });
  return actions;
}
