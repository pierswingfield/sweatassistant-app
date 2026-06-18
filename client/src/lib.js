// Shared client-side utilities that need London timezone awareness
import { DateTime } from 'luxon';

// Calculate booking offset in days based on settings
export function getBookingOffset(settings = {}) {
  let days = 8;
  if (settings.advancedBooking) days += 7;
  if (settings.advancedBookingCredit) days += 7;
  return days;
}

// Calculate when booking opens for a specific class date (London timezone)
// Mirrors the server-side scheduler.js getClassReleaseTime exactly
export function getClassReleaseTime(classDateStr, settings = {}) {
  if (!classDateStr) return DateTime.now().setZone('Europe/London');

  const daysToAdd = getBookingOffset(settings);
  const classDt = DateTime.fromISO(classDateStr, { zone: 'Europe/London' });

  // Start M as Monday 12:00 PM of the class week
  let M = classDt.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });

  while (true) {
    const cutoff = M.plus({ days: daysToAdd }).set({ hour: 23, minute: 59, second: 59, millisecond: 999 });
    if (cutoff < classDt) {
      M = M.plus({ weeks: 1 });
      break;
    }
    M = M.minus({ weeks: 1 });
  }

  return M.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
}

// Get the next Monday 12:00 PM London time
export function getNextMondayNoonLondon() {
  const now = DateTime.now().setZone('Europe/London');
  let target = now.set({ weekday: 1, hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (now >= target) {
    target = target.plus({ weeks: 1 });
  }
  return target;
}

// Format a countdown from milliseconds
export function formatCountdown(diffMs) {
  if (diffMs <= 0) return '00:00:00';

  const hours = Math.floor(diffMs / (3600 * 1000));
  const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  const secs = Math.floor((diffMs % (60 * 1000)) / 1000);

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }

  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Format a full countdown with days
export function formatFullCountdown(diffMs) {
  if (diffMs <= 0) return 'RELEASE ACTIVE!';

  const days = Math.floor(diffMs / (24 * 3600 * 1000));
  const hours = Math.floor((diffMs % (24 * 3600 * 1000)) / (3600 * 1000));
  const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  const secs = Math.floor((diffMs % (60 * 1000)) / 1000);

  return `${days}d ${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}
