// T10 Create a Team: a guided, multi-step flow (PLAN-teams.md §5.6 step 1, redesigned).
// Name -> Emoji -> Your sharing -> Ready. The app mascot is the guide: one speech-bubble line
// per step, above the Team avatar that builds up as the member goes (name, then the emoji
// badge). One modal-nav page (full screen on mobile, DESIGN.md §6.2.1); steps swap its body.
// The pure rules (steps, validation, suggestions, emoji grid, share text) live in
// teams-create-model.js. Every interpolated string goes through escapeHtml.

import { escapeHtml } from '../escape-html.js';
import { teamsApi } from '../teams-api.js';
import { showToast } from '../main.js';
import { defaultShare } from './teams-model.js';
import {
  T, fmt, ICONS, teamAvatar, errorText, openTeamsPage, setFooter, shareInvite, renderSharingSheet,
} from './teams-ui.js';
import {
  stepProgress, previousStep, liveNameError, checkStep, suggestionSet, EMOJI_CHOICES,
} from './teams-create-model.js';

const CROWN = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3.5 8 4.6 4.2L12 5l3.9 7.2L20.5 8l-1.8 10.5H5.3Z"/><path d="M5.5 21h13"/></svg>';

function nameError(code) {
  return code === 'tooLong' ? T.nameTooLong : code === 'angle' ? T.nameAngle : T.nameRequired;
}

/** Pure markup for the progress indicator (tested). */
export function progressHtml(step) {
  const p = stepProgress(step);
  if (!p.showProgress) return '';
  const label = fmt(T.stepOf, { n: p.index, total: p.total });
  const segs = Array.from({ length: p.total }, (_, i) => `<span class="tm-cf-seg${i < p.index ? ' is-done' : ''}${i === p.index - 1 ? ' is-current' : ''}"></span>`).join('');
  return `<div class="tm-cf-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${p.total}" aria-valuenow="${p.index}" aria-label="${escapeHtml(label)}"><span class="tm-cf-segs">${segs}</span><span class="tm-cf-step">${escapeHtml(label)}</span></div>`;
}

/** Pure markup: the mascot's speech bubble (tested for escaping). */
export function bubbleHtml(text) {
  return `<p class="tm-cf-bubble">${escapeHtml(text)}</p>`;
}

/** Pure markup: the name suggestion chips for a seed (shared with the edit flow). */
export function suggestionsHtml(seed) {
  return suggestionSet(seed, 5).map((s) => `<button type="button" class="tm-cf-suggest" data-suggest="${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('');
}

/** Pure markup: the emoji grid plus "type any emoji" (shared with the edit flow). */
export function emojiPickerHtml(selected) {
  const sel = selected || '';
  const cell = (e) => `<button type="button" class="tm-cf-emo${sel === e ? ' is-on' : ''}" role="radio" aria-checked="${sel === e}" data-emoji="${escapeHtml(e)}" aria-label="${escapeHtml(fmt(T.emojiPick, { emoji: e }))}">${escapeHtml(e)}</button>`;
  const typed = sel && !EMOJI_CHOICES.includes(sel) ? sel : '';
  return `<div class="tm-cf-emojis" role="radiogroup" aria-label="${escapeHtml(T.emojiGridLabel)}">${EMOJI_CHOICES.map(cell).join('')}
      <button type="button" class="tm-cf-emo tm-cf-emo-none${sel ? '' : ' is-on'}" role="radio" aria-checked="${!sel}" data-emoji="" aria-label="${escapeHtml(T.emojiNoneAria)}">${escapeHtml(T.emojiNone)}</button>
    </div>
    <label class="tm-cf-other"><span class="tm-cf-label">${escapeHtml(T.emojiOther)}</span>
      <input type="text" class="tm-cf-other-input${typed ? ' is-on' : ''}" name="teamEmoji" maxlength="16" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(T.emojiOtherAria)}" placeholder="🙂">
    </label>
    <p class="tm-cf-error" role="alert" hidden></p>`;
}

/** Pure markup: the ready page's content (tested). No page title: the avatar leads. */
export function readyHtml(team) {
  const name = String(team?.name ?? '');
  const captain = fmt(T.captainOf, { name: '\u0000' }).split('\u0000').map(escapeHtml).join(`<b>${escapeHtml(name)}</b>`);
  return `<div class="tm-cf-hero">
      <span class="tm-cf-glow" aria-hidden="true"></span>
      ${teamAvatar({ emoji: team?.emoji, size: 'hero', pose: 'warming', alt: fmt(T.avatarAria, { name }) })}
      <p class="tm-cf-readyname">${escapeHtml(name)}</p>
    </div>
    <h2 class="tm-cf-readyhead">${escapeHtml(T.readyHeading)}</h2>
    <div class="tm-cf-captain"><span class="tm-cf-captain-ico">${CROWN}</span><span>${captain}</span></div>
    <p class="tm-cf-cta">${escapeHtml(T.readyCta)}</p>
    <div class="tm-cf-actions">
      <button type="button" class="tm-btn tm-btn-primary tm-btn-pill tm-btn-block tm-cf-share" data-cf-share>${ICONS.share}<span>${escapeHtml(T.share)}</span></button>
      <button type="button" class="tm-btn tm-btn-ghost tm-btn-pill tm-btn-block" data-cf-go>${escapeHtml(T.goToTeam)}</button>
    </div>`;
}

/**
 * Open the flow. `onCreated(team)` runs once the server has created the Team (refresh the
 * list); `onGoToTeam(team)` navigates to it after the page has closed.
 */
export function openCreateTeamFlow({ onCreated = () => {}, onGoToTeam = () => {} } = {}) {
  const page = openTeamsPage({ id: 'teams-create', title: T.createTitle });
  page.overlay.classList.add('tm-cf-ovl');
  const draft = { name: '', emoji: '', share: defaultShare() };
  let seed = Math.floor(Math.random() * 1000);
  let created = null;

  const shell = (step, inner) => {
    page.overlay.classList.toggle('is-untitled', step === 'ready');
    page.body.innerHTML = `<div class="tm-cf tm-cf--${step}" data-cf-step="${step}">${progressHtml(step)}${inner}</div>`;
    page.body.scrollTop = 0;
  };

  const avatarFor = (size, { emptyBadge = false } = {}) => teamAvatar({ emoji: draft.emoji || null, size, pose: 'warming', emptyBadge });

  // ---- 1. Name -------------------------------------------------------------------------------
  const stepName = () => {
    page.setTitle(T.createTitle);
    const suggestions = () => suggestionsHtml(seed);
    shell('name', `
      <div class="tm-cf-guide">${bubbleHtml(T.guideName)}${avatarFor('lg')}</div>
      <label class="tm-cf-namefield">
        <span class="u-visually-hidden">${escapeHtml(T.nameLabel)}</span>
        <input type="text" class="tm-cf-name" name="teamName" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="next" placeholder="${escapeHtml(T.namePlaceholder)}">
      </label>
      <p class="tm-cf-error" role="alert" hidden></p>
      <div class="tm-cf-ideas">
        <p class="tm-cf-label">${escapeHtml(T.suggestionsLabel)}</p>
        <div class="tm-cf-suggests" data-suggests>${suggestions()}</div>
        <button type="button" class="tm-cf-more" data-more>${ICONS.sort}<span>${escapeHtml(T.moreIdeas)}</span></button>
      </div>`);
    const input = page.body.querySelector('.tm-cf-name');
    const errEl = page.body.querySelector('.tm-cf-error');
    input.value = draft.name;
    const showError = (code) => {
      errEl.hidden = !code;
      errEl.textContent = code ? nameError(code) : '';
      input.classList.toggle('is-invalid', !!code);
      input.setAttribute('aria-invalid', code ? 'true' : 'false');
    };
    input.addEventListener('input', () => { draft.name = input.value; showError(liveNameError(input.value)); });
    const wireSuggestions = () => page.body.querySelectorAll('[data-suggest]').forEach((b) => b.addEventListener('click', () => {
      input.value = b.getAttribute('data-suggest');
      draft.name = input.value;
      showError(null);
      page.body.querySelectorAll('[data-suggest]').forEach((x) => x.classList.toggle('is-on', x === b));
    }));
    wireSuggestions();
    page.body.querySelector('[data-more]').addEventListener('click', () => {
      seed += 1;
      page.body.querySelector('[data-suggests]').innerHTML = suggestions();
      wireSuggestions();
    });
    const next = () => {
      const r = checkStep('name', { name: input.value });
      if (!r.ok) { showError(r.error); input.focus(); return; }
      draft.name = r.value;
      stepEmoji();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    setFooter(page, [{ label: T.continue, kind: 'primary', onClick: next }]);
  };

  // ---- 2. Emoji ------------------------------------------------------------------------------
  const stepEmoji = () => {
    page.setTitle(T.emojiStepTitle);
    shell('emoji', `
      <div class="tm-cf-guide">${bubbleHtml(T.guideEmoji)}<span data-cf-preview>${avatarFor('lg', { emptyBadge: true })}</span><p class="tm-cf-previewname">${escapeHtml(draft.name)}</p></div>
      ${emojiPickerHtml(draft.emoji)}`);
    const typed = draft.emoji && !EMOJI_CHOICES.includes(draft.emoji) ? draft.emoji : '';
    const preview = page.body.querySelector('[data-cf-preview]');
    const other = page.body.querySelector('.tm-cf-other-input');
    const errEl = page.body.querySelector('.tm-cf-error');
    other.value = typed;
    let typedInvalid = false;
    const select = (emoji, { fromInput = false } = {}) => {
      draft.emoji = emoji;
      preview.innerHTML = avatarFor('lg', { emptyBadge: true });
      page.body.querySelectorAll('[data-emoji]').forEach((b) => {
        const on = !fromInput && b.getAttribute('data-emoji') === emoji;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-checked', String(on));
      });
      other.classList.toggle('is-on', fromInput && !!emoji);
      if (!fromInput) { other.value = ''; typedInvalid = false; }
      errEl.hidden = true;
    };
    page.body.querySelectorAll('[data-emoji]').forEach((b) => b.addEventListener('click', () => select(b.getAttribute('data-emoji'))));
    other.addEventListener('input', () => {
      const r = checkStep('emoji', { emoji: other.value });
      typedInvalid = false;
      if (!other.value.trim()) { select('', { fromInput: true }); return; }
      if (r.ok) select(r.value, { fromInput: true });
      else { typedInvalid = true; errEl.textContent = T.emojiInvalid; errEl.hidden = false; }
    });
    const next = () => {
      if (typedInvalid) { errEl.textContent = T.emojiInvalid; errEl.hidden = false; return; }
      const r = checkStep('emoji', { emoji: draft.emoji });
      if (!r.ok) { errEl.textContent = T.emojiInvalid; errEl.hidden = false; return; }
      draft.emoji = r.value || '';
      stepSharing();
    };
    setFooter(page, [
      { label: T.backStep, kind: 'ghost', onClick: () => back('emoji') },
      { label: T.continue, kind: 'primary', onClick: next },
    ]);
  };

  // ---- 3. Your sharing -----------------------------------------------------------------------
  const stepSharing = () => {
    page.setTitle(T.yourSharing);
    shell('sharing', `
      <div class="tm-cf-guide">${bubbleHtml(T.guideSharing)}</div>
      <div class="tm-cf-hero">
        <span class="tm-cf-glow" aria-hidden="true"></span>
        ${avatarFor('hero')}
        <h2 class="tm-cf-teamname">${escapeHtml(draft.name)}</h2>
        <p class="tm-cf-sub">${escapeHtml(fmt(T.sharingSubtitle, { name: draft.name }))}</p>
      </div>
      <div class="tm-sheet tm-cf-sheet"></div>`);
    const sheet = renderSharingSheet(page.body.querySelector('.tm-sheet'), { share: draft.share, onChange: (s) => { draft.share = s; } });
    const [backBtn] = setFooter(page, [
      { label: T.backStep, kind: 'ghost', onClick: () => back('sharing') },
      {
        label: T.createAction,
        kind: 'primary',
        onClick: async (btn) => {
          btn.disabled = true;
          backBtn.disabled = true;
          btn.textContent = T.creating;
          try {
            draft.share = sheet.getShare();
            const res = await teamsApi.create({ name: draft.name, emoji: draft.emoji || null, share: draft.share });
            created = res;
            try { onCreated(res.team); } catch (_) { /* list refresh is best effort */ }
            stepReady(res);
          } catch (err) {
            btn.disabled = false;
            backBtn.disabled = false;
            btn.textContent = T.createAction;
            showToast(errorText(err), 'error');
          }
        },
      },
    ]);
  };

  // ---- 4. Ready ------------------------------------------------------------------------------
  const stepReady = ({ team, inviteToken }) => {
    page.setTitle(T.readyHeading); // visually hidden (.is-untitled); keeps the dialog labelled
    shell('ready', readyHtml(team));
    setFooter(page, []);
    page.body.querySelector('[data-cf-share]').addEventListener('click', () => shareInvite(team, { url: inviteToken }));
    page.body.querySelector('[data-cf-go]').addEventListener('click', () => page.closeThen(() => onGoToTeam(team)));
  };

  const back = (from) => {
    const prev = previousStep(from);
    if (prev === 'name') stepName();
    else if (prev === 'emoji') stepEmoji();
  };

  stepName();
  return { page, getDraft: () => ({ ...draft }), getCreated: () => created };
}
