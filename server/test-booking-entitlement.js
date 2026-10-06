'use strict';

const assert = require('assert');
const { countSelfBookings, validateSelfBookingLimit } = require('./booking-entitlement');

const bookings = [
  { eventId: 'class-1', isGuest: false },
  { eventId: 'class-1', isGuest: true },
  { eventId: 'class-2', isGuest: false },
];
assert.strictEqual(countSelfBookings(bookings, 'class-1'), 1, 'guest reservations do not consume self entitlement');
assert.deepStrictEqual(validateSelfBookingLimit({ currentSelfBookings: 0, requestedSelfBookings: 1, selfBookingLimit: 1 }).ok, true);
assert.strictEqual(validateSelfBookingLimit({ currentSelfBookings: 1, requestedSelfBookings: 1, selfBookingLimit: 1 }).code, 'ATTENDEE_LIMIT_EXCEEDED');
assert.strictEqual(validateSelfBookingLimit({ currentSelfBookings: 1, requestedSelfBookings: 1, selfBookingLimit: 2 }).ok, true);
console.log('✅ server booking entitlement count/limit checks');
