// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderFeedbackForm, validateFeedback, feedbackCopy, FEEDBACK_TYPES } from './feedback.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const until = async (cond, ms = 3000) => {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
};

function mount(opts = {}) {
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root');
  renderFeedbackForm(root, { appName: 'Dibs', ...opts });
  return root;
}
const fill = (root, { type = 'bug', title = 'Broken thing', message = 'It broke.', email } = {}) => {
  if (type) root.querySelector(`input[name="type"][value="${type}"]`).checked = true;
  root.querySelector('#app-feedback-title').value = title;
  root.querySelector('#app-feedback-message').value = message;
  if (email !== undefined) root.querySelector('#app-feedback-email').value = email;
};
const submit = (root) => root.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

describe('Send Feedback form', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders the exact copy, the four types, and prefills the account email', () => {
    const root = mount({ accountEmail: 'me@example.com' });
    const text = root.textContent;
    expect(text).toContain('Dibs is in beta and we would like your feedback!');
    expect(text).toContain('Something broken? Want a gym added? Have a great idea for a feature? Use the form to share it with us.');
    expect(text).toContain('Can we follow up with you?');
    expect([...root.querySelectorAll('.app-feedback-type-label')].map((n) => n.textContent))
      .toEqual(['Bug report', 'New gym request', 'Feature request', 'General enquiry']);
    expect(root.querySelector('#app-feedback-email').value).toBe('me@example.com');
    expect(root.querySelector('.app-feedback-submit').textContent).toBe('Submit');
    expect(feedbackCopy('Dibs').title).toBe('Dibs is in beta and we would like your feedback!');
  });

  it('has no inline event handlers and escapes the prefilled email', () => {
    const root = mount({ accountEmail: '"><img src=x onerror=alert(1)>' });
    const attrs = [...root.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name));
    expect(attrs.filter((n) => /^on/i.test(n))).toEqual([]);
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('#app-feedback-email').value).toBe('"><img src=x onerror=alert(1)>');
  });

  it('validates inline and does not submit when required fields are missing', async () => {
    const send = vi.fn();
    const root = mount({ submit: send });
    submit(root);
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(root.querySelector('#app-feedback-err-type').textContent).toBe('Choose a type.');
    expect(root.querySelector('#app-feedback-err-title').textContent).toBe('Add a short title.');
    expect(root.querySelector('#app-feedback-err-message').textContent).toBe('Tell us a little more.');
    expect(root.querySelector('[data-field="title"]').classList.contains('has-error')).toBe(true);
    expect(root.querySelector('#app-feedback-title').getAttribute('aria-invalid')).toBe('true');
    // Fixing a field clears its error as you type.
    const title = root.querySelector('#app-feedback-title');
    title.value = 'Now titled';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    expect(root.querySelector('#app-feedback-err-title').textContent).toBe('');
  });

  it('rejects a malformed optional email but accepts a blank one', () => {
    expect(validateFeedback({ type: 'bug', title: 't', message: 'm', email: 'nope' }).email).toBeTruthy();
    expect(validateFeedback({ type: 'bug', title: 't', message: 'm', email: '' })).toEqual({});
    expect(validateFeedback({ type: 'x', title: 't', message: 'm' }).type).toBeTruthy();
    expect(validateFeedback({ type: 'bug', title: 'x'.repeat(121), message: 'm' }).title).toBeTruthy();
    expect(FEEDBACK_TYPES.map((t) => t.id)).toEqual(['bug', 'gym', 'feature', 'general']);
  });

  it('submits trimmed values and shows the thank-you state on success', async () => {
    const send = vi.fn(async () => ({ ok: true, status: 201, data: { ok: true, id: 7 } }));
    const root = mount({ submit: send, accountEmail: 'me@example.com' });
    fill(root, { type: 'gym', title: '  Add a gym  ', message: '  Please add one.  ' });
    submit(root);
    await until(() => root.querySelector('.app-feedback-thanks'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'gym', title: 'Add a gym', message: 'Please add one.', email: 'me@example.com' });
    expect(typeof send.mock.calls[0][0].build).toBe('string');
    expect(root.textContent).toContain('Thank you!');
    // "Send more feedback" brings a fresh form back.
    root.querySelector('.app-feedback-again').click();
    expect(root.querySelector('form')).not.toBeNull();
    expect(root.querySelector('#app-feedback-title').value).toBe('');
  });

  it('keeps the form and shows the server message when the submission fails', async () => {
    const send = vi.fn(async () => ({ ok: false, status: 429, data: { message: 'Please try again in an hour.' } }));
    const root = mount({ submit: send });
    fill(root);
    submit(root);
    await until(() => !root.querySelector('.app-feedback-form-error').hidden);
    await until(() => !root.querySelector('.app-feedback-submit').hasAttribute('aria-busy'));
    expect(root.querySelector('.app-feedback-thanks')).toBeNull();
    expect(root.querySelector('.app-feedback-form-error').textContent).toBe('Please try again in an hour.');
    expect(root.querySelector('#app-feedback-title').value).toBe('Broken thing');
  });

  it('maps server field errors back onto the fields', async () => {
    const send = vi.fn(async () => ({ ok: false, status: 400, data: { message: 'Please check the highlighted fields.', errors: { email: 'Enter a valid email address, or leave it blank.' } } }));
    const root = mount({ submit: send });
    fill(root, { email: 'a@b.co' });
    submit(root);
    await until(() => root.querySelector('#app-feedback-err-email').textContent);
    expect(root.querySelector('[data-field="email"]').classList.contains('has-error')).toBe(true);
  });

  it('treats a network error as a failure, not a success', async () => {
    const send = vi.fn(async () => { throw new TypeError('Load failed'); });
    const root = mount({ submit: send });
    fill(root);
    submit(root);
    await until(() => !root.querySelector('.app-feedback-form-error').hidden);
    expect(root.querySelector('.app-feedback-thanks')).toBeNull();
  });
});
