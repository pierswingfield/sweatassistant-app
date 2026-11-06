// T12 Edit a Team's name and emoji (Captains). One modal-nav page that reuses the redesigned
// create-flow pieces (teams-create.js): the big name input (placeholder clears on focus),
// name suggestions, the emoji grid and a live Team avatar preview. Save sends only what
// changed. The pure markup/diff helpers are exported for tests; every interpolated string goes
// through escapeHtml.

import { escapeHtml } from '../escape-html.js';
import { teamsApi } from '../teams-api.js';
import { showToast } from '../main.js';
import { T, ICONS, teamAvatar, errorText, openTeamsPage, setFooter } from './teams-ui.js';
import { suggestionsHtml, emojiPickerHtml } from './teams-create.js';
import { checkStep, liveNameError } from './teams-create-model.js';

function nameError(code) {
  return code === 'tooLong' ? T.nameTooLong : code === 'angle' ? T.nameAngle : T.nameRequired;
}

/** The fields to PATCH: only what differs from the saved Team (emoji '' / null both mean none). */
export function editChanges(team, { name, emoji }) {
  const out = {};
  if (name !== team.name) out.name = name;
  if ((emoji || null) !== (team.emoji || null)) out.emoji = emoji || null;
  return out;
}

/** Pure markup for the page body. */
export function editBodyHtml(team, seed = 0) {
  return `<div class="tm-cf tm-cf--edit">
      <div class="tm-cf-guide"><span data-cf-preview>${teamAvatar({ emoji: team.emoji || null, size: 'lg', pose: 'warming', emptyBadge: true })}</span></div>
      <label class="tm-cf-namefield">
        <span class="u-visually-hidden">${escapeHtml(T.nameLabel)}</span>
        <input type="text" class="tm-cf-name" name="teamName" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done" placeholder="${escapeHtml(T.namePlaceholder)}">
      </label>
      <p class="tm-cf-error" role="alert" data-name-error hidden></p>
      <div class="tm-cf-ideas">
        <p class="tm-cf-label">${escapeHtml(T.suggestionsLabel)}</p>
        <div class="tm-cf-suggests" data-suggests>${suggestionsHtml(seed)}</div>
        <button type="button" class="tm-cf-more" data-more>${ICONS.sort}<span>${escapeHtml(T.moreIdeas)}</span></button>
      </div>
      <p class="tm-cf-label tm-cf-sectionlabel">${escapeHtml(T.emojiStepTitle)}</p>
      ${emojiPickerHtml(team.emoji || '')}
    </div>`;
}

export function openEditTeamPage(team, { onSaved = null } = {}) {
  const page = openTeamsPage({ id: 'teams-edit', title: T.renameTitle });
  page.overlay.classList.add('tm-cf-ovl');
  let seed = Math.floor(Math.random() * 1000);
  const draft = { name: team.name, emoji: team.emoji || '' };
  page.body.innerHTML = editBodyHtml(team, seed);

  const input = page.body.querySelector('.tm-cf-name');
  const nameErr = page.body.querySelector('[data-name-error]');
  const emojiErr = page.body.querySelector('.tm-cf-error:not([data-name-error])');
  const other = page.body.querySelector('.tm-cf-other-input');
  const preview = page.body.querySelector('[data-cf-preview]');
  input.value = draft.name;
  other.value = draft.emoji && ![...page.body.querySelectorAll('[data-emoji]')].some((b) => b.getAttribute('data-emoji') === draft.emoji) ? draft.emoji : '';

  const paintPreview = () => { preview.innerHTML = teamAvatar({ emoji: draft.emoji || null, size: 'lg', pose: 'warming', emptyBadge: true }); };
  const showNameError = (code) => {
    nameErr.hidden = !code;
    nameErr.textContent = code ? nameError(code) : '';
    input.classList.toggle('is-invalid', !!code);
    input.setAttribute('aria-invalid', code ? 'true' : 'false');
  };
  input.addEventListener('input', () => { draft.name = input.value; showNameError(liveNameError(input.value)); });

  const wireSuggestions = () => page.body.querySelectorAll('[data-suggest]').forEach((b) => b.addEventListener('click', () => {
    input.value = b.getAttribute('data-suggest');
    draft.name = input.value;
    showNameError(null);
    page.body.querySelectorAll('[data-suggest]').forEach((x) => x.classList.toggle('is-on', x === b));
  }));
  wireSuggestions();
  page.body.querySelector('[data-more]').addEventListener('click', () => {
    seed += 1;
    page.body.querySelector('[data-suggests]').innerHTML = suggestionsHtml(seed);
    wireSuggestions();
  });

  let typedInvalid = false;
  let saving = false;
  const select = (emoji, { fromInput = false } = {}) => {
    draft.emoji = emoji;
    paintPreview();
    page.body.querySelectorAll('[data-emoji]').forEach((b) => {
      const on = !fromInput && b.getAttribute('data-emoji') === emoji;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
    other.classList.toggle('is-on', fromInput && !!emoji);
    if (!fromInput) { other.value = ''; typedInvalid = false; }
    emojiErr.hidden = true;
  };
  page.body.querySelectorAll('[data-emoji]').forEach((b) => b.addEventListener('click', () => select(b.getAttribute('data-emoji'))));
  other.addEventListener('input', () => {
    const r = checkStep('emoji', { emoji: other.value });
    typedInvalid = false;
    if (!other.value.trim()) { select('', { fromInput: true }); return; }
    if (r.ok) select(r.value, { fromInput: true });
    else { typedInvalid = true; emojiErr.textContent = T.emojiInvalid; emojiErr.hidden = false; }
  });

  const submit = async (btn) => {
    if (saving) return;
    const n = checkStep('name', { name: input.value });
    if (!n.ok) { showNameError(n.error); input.focus(); return; }
    const e = checkStep('emoji', { emoji: draft.emoji });
    if (typedInvalid || !e.ok) { emojiErr.textContent = T.emojiInvalid; emojiErr.hidden = false; return; }
    const changes = editChanges(team, { name: n.value, emoji: e.value || '' });
    if (!Object.keys(changes).length) { page.close(); return; }
    saving = true;
    if (btn) btn.disabled = true;
    try {
      await teamsApi.update(team.id, changes);
      showToast(T.saved, 'success');
      page.close();
      onSaved?.();
    } catch (err) {
      saving = false;
      if (btn) btn.disabled = false;
      showToast(errorText(err), 'error');
    }
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); submit(null); } });
  setFooter(page, [{ label: T.save, kind: 'primary', onClick: submit }]);
  return page;
}
