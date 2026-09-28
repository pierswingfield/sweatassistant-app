// U1-14 — rules for the spot picker, kept pure so they can be tested.
//
// The picker runs in three modes:
//   'book'      a real booking of THIS class: an occupied spot cannot be taken.
//   'quickbook' / 'autobook'  PREFERENCE setting. You are choosing which spots you
//               like for this studio, not a bike for this class, so every real
//               spot is selectable whether or not someone holds it today. (Quick-
//               Book then books the best AVAILABLE preferred spot, as always.)

/** @returns {{allowed: boolean, notice: null|'occupied'|'will-target'}} */
export function spotSelectionRule({ mode, isAvailable }) {
  if (isAvailable) return { allowed: true, notice: null };
  if (mode === 'book') return { allowed: false, notice: 'occupied' };
  // Auto-Book keeps its explanatory toast: it really will target that spot when
  // booking fires. Quick-Book has nothing to add.
  return { allowed: true, notice: mode === 'autobook' ? 'will-target' : null };
}

/** The first-time-setup intro shows for a preference mode on a studio with a seat map and no saved map. */
export function needsSetupIntro({ mode, hasSavedMap, hasSeatMap }) {
  return (mode === 'quickbook' || mode === 'autobook') && !!hasSeatMap && !hasSavedMap;
}

/** Exact copy for the intro. `gymName`/`locationName` are display names. */
export function setupIntroCopy({ gymName = '', locationName = '' } = {}) {
  const where = [gymName, locationName].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  return {
    header: 'First-time setup',
    sub: `Choose your preferred spots for ${where || 'this studio'} first.`,
    bodyHtml: 'Once set up, <b>Quick-Book</b> and <b>Auto-Book</b> will always book the best possible spot for you.',
    next: 'Next',
  };
}
