// T9 marketing empty state for members of no Team (pure markup; copy in copy.js COPY.teams).
// A frosted orb behind the mascot, a punchy headline, one promise, three benefit rows with
// custom inline SVG icons, a privacy reassurance, then Create. Joining is by invite link only.

const PITCH_ICONS = {
  see: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 3v3M16 3v3"/><path d="m9 15 2.2 2.2L15.5 13"/></svg>',
  goal: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12 19 5"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>',
};

/** Pure copy-to-rows for the marketing empty state (tested). */
export function pitchRows(copy) {
  return [
    { icon: 'book', title: copy.pitchBookTitle, body: copy.pitchBookBody },
    { icon: 'goal', title: copy.pitchGoalTitle, body: copy.pitchGoalBody },
  ];
}

export function pitchHtml(copy, { escapeHtml: esc, mascotHtml }) {
  return `<section class="tm-card tm-pitch">
      <div class="tm-orb">${mascotHtml({ size: 150, pose: 'warming' })}</div>
      <h4 class="tm-pitch-headline">${esc(copy.pitchHeadline)}</h4>
      <p class="tm-pitch-promise">${esc(copy.pitchPromise)}</p>
      <button type="button" class="tm-btn tm-btn-primary tm-btn-pill tm-btn-block" data-create>${esc(copy.createATeam)}</button>
      <ul class="tm-pitch-list">${pitchRows(copy).map((r) => `<li class="tm-pitch-row"><span class="tm-pitch-icon">${PITCH_ICONS[r.icon]}</span><span class="tm-pitch-text"><b>${esc(r.title)}</b><span>${esc(r.body)}</span></span></li>`).join('')}</ul>
      <p class="tm-pitch-privacy">${PITCH_ICONS.lock}<span>${esc(copy.pitchPrivacy)}</span></p>
      <p class="tm-pitch-join">${esc(copy.pitchJoinHint)}</p>
    </section>`;
}
