// Versions are immutable publication identifiers, recorded using server time.
const TERMS_VERSION = '2026-11-09';
const PRIVACY_VERSION = '2026-11-09';
const DISCLOSURE_VERSION = '2026-11-09';
const CURRENT_ACCEPTANCE = { accepted: true, termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION };
function validateAcceptance(value) {
  if (value?.accepted !== true || value.termsVersion !== TERMS_VERSION || value.privacyVersion !== PRIVACY_VERSION) {
    throw new Error('Please review and agree to the current Terms and Conditions and acknowledge the Privacy Policy.');
  }
}
// Provider profile contact fields are never retained as an alternative login.
function withoutLoginDetails(value) {
  if (Array.isArray(value)) return value.map(withoutLoginDetails);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/email|password|username|credential/i.test(key)).map(([k,v]) => [k, withoutLoginDetails(v)]));
}
function sessionMaterial(session) {
  if (!session) return null;
  // Both adapters issue normalized sessions; no raw login response is stored.
  return Object.fromEntries(['accessToken', 'refreshToken', 'expiresAt', 'cookies'].filter(k => session[k] != null).map(k => [k, session[k]]));
}
module.exports = { CURRENT_ACCEPTANCE, TERMS_VERSION, PRIVACY_VERSION, DISCLOSURE_VERSION, validateAcceptance, withoutLoginDetails, sessionMaterial };
