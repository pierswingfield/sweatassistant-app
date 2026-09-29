// Calendar feed preferences (U4-16). Pure: no DB, no I/O, so it is unit-testable
// on any Node and shared by the feed builder and the settings routes.
//
// The `calendar` account setting used to be { enabled, includeTentative, alarm }.
// includeTentative switched waitlist AND Auto-Book rows on together; alarm was
// one of none | 2h | penalty | both. It is now split into independent flags.
//
// MIGRATION IS READ-TIME AND NON-DESTRUCTIVE. A stored blob that lacks the new
// keys is interpreted through the legacy ones, so an existing subscriber's feed
// keeps exactly the events (and alarms) it had. The legacy keys are only dropped
// when the user next saves (applyCalendarPatch). Nothing is rewritten at boot,
// so there is no migration to forget to run.

const DEFAULT_PREFS = Object.freeze({
  includeWaitlists: false,
  includeAutoBook: false,
  remindBookingWindow: false,   // new events: off unless asked for
  reminders: Object.freeze({ twoHour: false, cancelWindow: false }),
});

const bool = (v) => v === true;

function normalizeCalendarPrefs(cal) {
  const c = cal && typeof cal === 'object' ? cal : {};
  const legacyTentative = bool(c.includeTentative);
  const legacyAlarm = typeof c.alarm === 'string' ? c.alarm : 'none';
  const r = c.reminders && typeof c.reminders === 'object' ? c.reminders : null;
  return {
    includeWaitlists: typeof c.includeWaitlists === 'boolean' ? c.includeWaitlists : legacyTentative,
    includeAutoBook: typeof c.includeAutoBook === 'boolean' ? c.includeAutoBook : legacyTentative,
    remindBookingWindow: bool(c.remindBookingWindow),
    reminders: {
      twoHour: r && typeof r.twoHour === 'boolean' ? r.twoHour : (legacyAlarm === '2h' || legacyAlarm === 'both'),
      cancelWindow: r && typeof r.cancelWindow === 'boolean' ? r.cancelWindow : (legacyAlarm === 'penalty' || legacyAlarm === 'both'),
    },
  };
}

/**
 * Merge a request body into the stored blob. Returns the NEW blob: `enabled` is
 * preserved, legacy keys are folded into the new ones and removed.
 */
function applyCalendarPatch(stored, body) {
  const base = normalizeCalendarPrefs(stored);
  const b = body && typeof body === 'object' ? body : {};
  // Legacy request shape (older clients / tests): one flag drives both.
  if (typeof b.includeTentative === 'boolean') { base.includeWaitlists = b.includeTentative; base.includeAutoBook = b.includeTentative; }
  if (typeof b.alarm === 'string') { base.reminders.twoHour = b.alarm === '2h' || b.alarm === 'both'; base.reminders.cancelWindow = b.alarm === 'penalty' || b.alarm === 'both'; }
  if (typeof b.includeWaitlists === 'boolean') base.includeWaitlists = b.includeWaitlists;
  if (typeof b.includeAutoBook === 'boolean') base.includeAutoBook = b.includeAutoBook;
  if (typeof b.remindBookingWindow === 'boolean') base.remindBookingWindow = b.remindBookingWindow;
  if (b.reminders && typeof b.reminders === 'object') {
    if (typeof b.reminders.twoHour === 'boolean') base.reminders.twoHour = b.reminders.twoHour;
    if (typeof b.reminders.cancelWindow === 'boolean') base.reminders.cancelWindow = b.reminders.cancelWindow;
  }
  const out = { ...(stored && typeof stored === 'object' ? stored : {}), ...base };
  delete out.includeTentative;
  delete out.alarm;
  return out;
}

module.exports = { DEFAULT_PREFS, normalizeCalendarPrefs, applyCalendarPatch };
