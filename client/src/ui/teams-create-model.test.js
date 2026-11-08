import { describe, it, expect } from 'vitest';
import {
  CREATE_STEPS, stepProgress, previousStep, nextStep, liveNameError, checkStep,
  NAME_SUGGESTIONS, suggestionSet, EMOJI_CHOICES, inviteSharePayload, inviteClipboardText,
} from './teams-create-model.js';
import { validateEmoji, validateTeamName } from './teams-model.js';
import { COPY, formatCopyText } from '../copy.js';

describe('create flow step model (T10)', () => {
  it('runs name -> emoji -> sharing -> ready', () => {
    expect(CREATE_STEPS).toEqual(['name', 'emoji', 'sharing', 'ready']);
    expect(nextStep('name')).toBe('emoji');
    expect(nextStep('sharing')).toBe('ready');
    expect(nextStep('ready')).toBe(null);
  });

  it('shows progress for the three input steps only', () => {
    expect(stepProgress('name')).toEqual({ index: 1, total: 3, fraction: 1 / 3, showProgress: true });
    expect(stepProgress('sharing')).toMatchObject({ index: 3, total: 3, showProgress: true });
    expect(stepProgress('ready').showProgress).toBe(false);
  });

  it('Back goes one step back, never from the first step or from ready', () => {
    expect(previousStep('name')).toBe(null);
    expect(previousStep('emoji')).toBe('name');
    expect(previousStep('sharing')).toBe('emoji');
    expect(previousStep('ready')).toBe(null);
  });
});

describe('name validation', () => {
  it('stays silent while typing, empty included; errs only past the limit or on < >', () => {
    expect(liveNameError('')).toBe(null);
    expect(liveNameError('   ')).toBe(null);
    expect(liveNameError('x'.repeat(40))).toBe(null);
    expect(liveNameError('x'.repeat(41))).toBe('tooLong');
    expect(liveNameError('a<b')).toBe('angle');
  });

  it('Continue needs a name, and normalises it', () => {
    expect(checkStep('name', { name: '  ' })).toEqual({ ok: false, error: 'required' });
    expect(checkStep('name', { name: '  Run   Club ' })).toEqual({ ok: true, value: 'Run Club' });
    expect(checkStep('name', { name: '🏃'.repeat(41) }).ok).toBe(false);
  });

  it('emoji is optional but must be one emoji', () => {
    expect(checkStep('emoji', { emoji: '' })).toEqual({ ok: true, value: null });
    expect(checkStep('emoji', { emoji: '🦖' })).toEqual({ ok: true, value: '🦖' });
    expect(checkStep('emoji', { emoji: 'ab' }).ok).toBe(false);
    expect(checkStep('emoji', { emoji: '🏃🏃' }).ok).toBe(false);
    expect(checkStep('sharing', {}).ok).toBe(true);
  });
});

describe('suggestions and emoji grid', () => {
  it('every suggestion is a valid Team name and they are unique', () => {
    expect(new Set(NAME_SUGGESTIONS).size).toBe(NAME_SUGGESTIONS.length);
    for (const s of NAME_SUGGESTIONS) expect(validateTeamName(s).ok).toBe(true);
  });

  it('a set never repeats and "More ideas" shows a different set', () => {
    const a = suggestionSet(0, 5);
    const b = suggestionSet(1, 5);
    expect(a).toHaveLength(5);
    expect(new Set(a).size).toBe(5);
    expect(b).not.toEqual(a);
    expect(suggestionSet(-3, 5)).toHaveLength(5);
    expect(suggestionSet(0, 5, [])).toEqual([]);
  });

  it('every curated emoji passes the same check the server applies', () => {
    expect(EMOJI_CHOICES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(EMOJI_CHOICES).size).toBe(EMOJI_CHOICES.length);
    for (const e of EMOJI_CHOICES) expect(validateEmoji(e)).toEqual({ ok: true, value: e });
  });
});

describe('invite share text', () => {
  const t = COPY.teams;
  const payload = (team) => inviteSharePayload(team, {
    url: 'https://x.test/t/abc', appName: 'Dibs', textTemplate: t.shareText, titleTemplate: t.shareTitle, format: formatCopyText,
  });

  it('reads "You\'re invited to <app>! Join my Team <emoji> <name>."', () => {
    const p = payload({ name: 'Run Club', emoji: '🏃' });
    expect(p.text).toBe("You're invited to Dibs! Join my Team 🏃 Run Club.");
    expect(p.url).toBe('https://x.test/t/abc');
    expect(p.title).toBe('Join Run Club on Dibs');
  });

  it('drops the emoji cleanly when the Team has none, and never HTML-escapes plain text', () => {
    expect(payload({ name: 'Rise & Grind', emoji: null }).text).toBe("You're invited to Dibs! Join my Team Rise & Grind.");
  });

  it('the clipboard fallback carries the message and the link', () => {
    expect(inviteClipboardText(payload({ name: 'Run Club', emoji: '🏃' }))).toBe("You're invited to Dibs! Join my Team 🏃 Run Club.\nhttps://x.test/t/abc");
  });
});
