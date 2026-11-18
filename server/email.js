// The ONLY module that sends mail. Resend over plain fetch; no dependency.
//
// Never throws into a caller: every function resolves to { ok: true } | { skipped: true } |
// { error: '<reason>' }. A silent no-op while RESEND_API_KEY is unset (dev, tests, and any
// deploy that has not opted in). Open/click tracking is never enabled (it is a per-domain
// setting in Resend and this module sends nothing that turns it on). The API key, tokens
// and links are never logged.
const crypto = require('crypto');
const config = require('./config');
const { log } = require('./logger');

const RESEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 8000;

let testTransport = null;
/** Tests: capture outgoing mail instead of sending. Pass null to restore. fn receives the full message. */
function _setTransportForTests(fn) { testTransport = typeof fn === 'function' ? fn : null; }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Link into the PWA. `params` values are URL-encoded here. */
function linkFor(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  return `${config.publicOrigin}${pathname}${qs ? `?${qs}` : ''}`;
}

async function send({ to, subject, text, html, idempotencyKey }) {
  const message = { from: config.emailFrom, to: [to], subject, text, html, ...(config.emailReplyTo ? { reply_to: config.emailReplyTo } : {}) };
  try {
    if (testTransport) { await testTransport({ ...message, idempotencyKey }); return { ok: true }; }
    const key = (process.env.RESEND_API_KEY || '').trim();
    if (!key) return { skipped: true };
    const res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn('email send failed', { status: res.status });
      return { error: `provider_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    // err.message can echo a URL but never the key or body; log only the class of failure.
    log.warn('email send failed', { reason: err && err.name === 'TimeoutError' ? 'timeout' : 'network' });
    return { error: 'network' };
  }
}

function layout(heading, bodyHtml) {
  return `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.5;max-width:520px;margin:0 auto;padding:24px">`
    + `<h2 style="margin:0 0 16px">${esc(heading)}</h2>${bodyHtml}</body></html>`;
}

/** "Account created" mail with a confirm-your-email link (valid 30 minutes). */
function sendAccountCreated({ to, verifyUrl, notMeUrl, idempotencyKey }) {
  const app = config.appName;
  const subject = `Welcome to ${app}: confirm your email`;
  const text = `Your ${app} account has been created.\n\nConfirm your email address (the link works once and expires in 30 minutes):\n${verifyUrl}${notMeUrl ? `\n\nDidn't create this account? Tell us here:\n${notMeUrl}` : ''}\n\n${NO_REPLY}`;
  const html = layout(`Welcome to ${app}`,
    `<p>Your ${esc(app)} account has been created.</p>`
    + `<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px">Confirm your email</a></p>`
    + `<p style="font-size:13px;color:#555">The link works once and expires in 30 minutes. If it does not open, paste this address into your browser:<br>${esc(verifyUrl)}</p>`
    + (notMeUrl ? `<p style="font-size:13px;color:#555"><a href="${esc(notMeUrl)}">Didn't create this account?</a></p>` : '')
    + NO_REPLY_HTML);
  return send({ to, subject, text, html, idempotencyKey });
}

/** Resent verification mail (no "account created" wording). */
function sendVerifyEmail({ to, verifyUrl, idempotencyKey }) {
  const app = config.appName;
  const subject = `Confirm your ${app} email`;
  const text = `Confirm your email address for ${app} (the link works once and expires in 30 minutes):\n${verifyUrl}\n\nIf you did not ask for this, you can ignore this email.`;
  const html = layout(`Confirm your email`,
    `<p>Confirm your email address for ${esc(app)}.</p>`
    + `<p><a href="${esc(verifyUrl)}" style="display:inline-block;padding:10px 18px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px">Confirm your email</a></p>`
    + `<p style="font-size:13px;color:#555">The link works once and expires in 30 minutes. If it does not open, paste this address into your browser:<br>${esc(verifyUrl)}</p>`
    + `<p style="font-size:13px;color:#555">If you did not ask for this, you can ignore this email.</p>`);
  return send({ to, subject, text, html, idempotencyKey });
}

/** One-off neutral service notice ("an account exists for this address"). No token, no promotion, no tracking. */
function sendAccountCreatedNotice({ to, signInUrl, helpUrl, notMeUrl, idempotencyKey }) {
  const app = config.appName;
  const subject = `Your ${app} account`;
  const text = `An account has been created for this email address on ${app}.\n\nSign in: ${signInUrl}\n\nIf you did not create this account${notMeUrl ? `, tell us here:\n${notMeUrl}\n\nOr` : ','} reset the password to secure it:\n${helpUrl}\n\nThis is a one-off service message about your account. ${NO_REPLY}`;
  const html = layout(`Your ${app} account`,
    `<p>An account has been created for this email address on ${esc(app)}.</p>`
    + `<p>Sign in at <a href="${esc(signInUrl)}">${esc(signInUrl)}</a>.</p>`
    + `<p style="font-size:13px;color:#555">If you did not create this account, ${notMeUrl ? `<a href="${esc(notMeUrl)}">tell us here</a>, or ` : ''}<a href="${esc(helpUrl)}">reset the password</a> to secure it.</p>`
    + `<p style="font-size:13px;color:#555">This is a one-off service message about your account.</p>`
    + NO_REPLY_HTML);
  return send({ to, subject, text, html, idempotencyKey });
}

/** Mint a verify token for the account and mail the link. Never throws. */
async function issueAndSendVerification(userId, email, { welcome = false } = {}) {
  try {
    const tokens = require('./account-email-tokens');
    const t = tokens.issue(userId, 'verify');
    const verifyUrl = linkFor('/verify-email', { token: t.token });
    const notMeUrl = welcome ? linkFor('/not-me', { token: tokens.issue(userId, 'not_me').token }) : undefined;
    const mail = { to: email, verifyUrl, notMeUrl, idempotencyKey: `verify-${t.id}-${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 8)}` };
    return await (welcome ? sendAccountCreated(mail) : sendVerifyEmail(mail));
  } catch (err) {
    log.warn('email verification issue failed', { reason: err && err.message });
    return { error: 'internal' };
  }
}

const NO_REPLY = 'This address does not receive replies. To reach us, use Send Feedback in the app.';
const NO_REPLY_HTML = `<p style="font-size:13px;color:#555">${NO_REPLY}</p>`;
const BTN = 'display:inline-block;padding:10px 18px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:8px';

/** Password reset mail: single-use link, 30 minutes. */
function sendPasswordReset({ to, resetUrl, idempotencyKey }) {
  const app = config.appName;
  const subject = `Reset your ${app} password`;
  const text = `Someone asked to reset the password for your ${app} account.\n\nChoose a new password (the link works once and expires in 30 minutes):\n${resetUrl}\n\nResetting also disconnects your saved gym logins, so you will reconnect each gym afterwards.\n\nIf this was not you, ignore this email: your password has not changed.`;
  const html = layout('Reset your password',
    `<p>Someone asked to reset the password for your ${esc(app)} account.</p>`
    + `<p><a href="${esc(resetUrl)}" style="${BTN}">Choose a new password</a></p>`
    + `<p style="font-size:13px;color:#555">The link works once and expires in 30 minutes. If it does not open, paste this address into your browser:<br>${esc(resetUrl)}</p>`
    + `<p style="font-size:13px;color:#555">Resetting also disconnects your saved gym logins, so you will reconnect each gym afterwards.</p>`
    + `<p style="font-size:13px;color:#555">If this was not you, ignore this email: your password has not changed.</p>`);
  return send({ to, subject, text, html, idempotencyKey });
}

/** Neutral "your password was changed" notice. Carries a link to the request page, never a token. */
function sendPasswordChanged({ to, helpUrl }) {
  const app = config.appName;
  const subject = `Your ${app} password was changed`;
  const text = `The password for your ${app} account was just changed.\n\nIf that was you, no action is needed. If it was not, reset your password now:\n${helpUrl}\n\n${NO_REPLY}`;
  const html = layout('Your password was changed',
    `<p>The password for your ${esc(app)} account was just changed.</p>`
    + `<p style="font-size:13px;color:#555">If that was you, no action is needed. If it was not, <a href="${esc(helpUrl)}">reset your password</a> now.</p>` + NO_REPLY_HTML);
  return send({ to, subject, text, html });
}

/** Mint a reset token for the account and mail the link. Never throws. */
async function issueAndSendReset(userId, email) {
  try {
    const t = require('./account-email-tokens').issue(userId, 'reset');
    const resetUrl = linkFor('/reset-password', { token: t.token });
    return await sendPasswordReset({ to: email, resetUrl, idempotencyKey: `reset-${t.id}` });
  } catch (err) {
    log.warn('password reset issue failed', { reason: err && err.message });
    return { error: 'internal' };
  }
}

/** Fire-and-forget notice that the password changed. Never throws, never blocks the caller. */
function notifyPasswordChanged(email) {
  if (!email) return;
  sendPasswordChanged({ to: email, helpUrl: linkFor('/reset-password') }).catch(() => {});
}

/** a***@e***.com: enough for the owner to recognise the address, not enough to learn it. */
function maskEmail(addr) {
  const [local = '', domain = ''] = String(addr).split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

/** Confirmation link for a requested email change, sent to the NEW address. */
function sendEmailChangeConfirm({ to, confirmUrl, idempotencyKey }) {
  const app = config.appName;
  const subject = `Confirm your new ${app} email`;
  const text = `Someone asked to use this address for a ${app} account.\n\nConfirm the change (the link works once and expires in 30 minutes):\n${confirmUrl}\n\nIf you did not ask for this, ignore this email: nothing will change.`;
  const html = layout('Confirm your new email',
    `<p>Someone asked to use this address for a ${esc(app)} account.</p>`
    + `<p><a href="${esc(confirmUrl)}" style="${BTN}">Confirm new email</a></p>`
    + `<p style="font-size:13px;color:#555">The link works once and expires in 30 minutes. If it does not open, paste this address into your browser:<br>${esc(confirmUrl)}</p>`
    + `<p style="font-size:13px;color:#555">If you did not ask for this, ignore this email: nothing will change.</p>`);
  return send({ to, subject, text, html, idempotencyKey });
}

/** Notice to the CURRENT address that a change was requested. Never carries a token. */
function sendEmailChangeRequested({ to, maskedNew, helpUrl }) {
  const app = config.appName;
  const subject = `A change to your ${app} email was requested`;
  const text = `A change of the email address on your ${app} account to ${maskedNew} was requested.\n\nNothing changes until that address is confirmed. If this was not you, reset your password now:\n${helpUrl}`;
  const html = layout('Email change requested',
    `<p>A change of the email address on your ${esc(app)} account to <strong>${esc(maskedNew)}</strong> was requested.</p>`
    + `<p style="font-size:13px;color:#555">Nothing changes until that address is confirmed. If this was not you, <a href="${esc(helpUrl)}">reset your password</a> now.</p>`);
  return send({ to, subject, text, html });
}

/** Final notice to the OLD address once the change has happened. */
function sendEmailChanged({ to, maskedNew, helpUrl }) {
  const app = config.appName;
  const subject = `Your ${app} email was changed`;
  const text = `The email address on your ${app} account was changed to ${maskedNew}. This address no longer signs in to the account.\n\nIf this was not you, reset your password now:\n${helpUrl}\n\n${NO_REPLY}`;
  const html = layout('Your email was changed',
    `<p>The email address on your ${esc(app)} account was changed to <strong>${esc(maskedNew)}</strong>. This address no longer signs in to the account.</p>`
    + `<p style="font-size:13px;color:#555">If this was not you, <a href="${esc(helpUrl)}">reset your password</a> now.</p>` + NO_REPLY_HTML);
  return send({ to, subject, text, html });
}

/** Fire-and-forget notice to the old address that a change was requested / completed. Never throws. */
function notifyEmailChangeRequested(oldEmail, newEmail) {
  sendEmailChangeRequested({ to: oldEmail, maskedNew: maskEmail(newEmail), helpUrl: linkFor('/reset-password') }).catch(() => {});
}
function notifyEmailChanged(oldEmail, newEmail) {
  sendEmailChanged({ to: oldEmail, maskedNew: maskEmail(newEmail), helpUrl: linkFor('/reset-password') }).catch(() => {});
}

/** Mail the confirmation link for an already-issued email_change token to the new address. Never throws. */
async function sendEmailChangeLink(to, token, tokenId) {
  try {
    return await sendEmailChangeConfirm({ to, confirmUrl: linkFor('/confirm-email', { token }), idempotencyKey: `email-change-${tokenId}` });
  } catch (err) {
    log.warn('email change mail failed', { reason: err && err.message });
    return { error: 'internal' };
  }
}

module.exports = { sendEmailChangeRequested, sendEmailChanged, maskEmail, notifyEmailChangeRequested, notifyEmailChanged, sendEmailChangeLink, sendEmailChangeConfirm, sendPasswordReset, sendPasswordChanged, issueAndSendReset, notifyPasswordChanged, send, sendAccountCreated, sendAccountCreatedNotice, sendVerifyEmail, issueAndSendVerification, linkFor, _setTransportForTests };
