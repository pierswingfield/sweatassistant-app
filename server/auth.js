const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { getProvider } = require('./providers');
const gymOutbound = require('./gym-outbound');
const { log } = require('./logger');

const { findDevMockGym } = require('./gyms.config');

const JWT_SECRET = require('./secrets').userJwtSecret();

// Every session token embeds the account's current token_version (`tv`). A password
// change, admin reset or account deletion bumps/removes it, which revokes all older
// tokens. A token with NO `tv` claim (issued before this shipped) counts as version 0,
// so it stays valid until its natural expiry unless the version has since been bumped.
function signUserToken(userId, email) {
  return jwt.sign({ userId, email, tv: db.getTokenVersion(userId) || 0 }, JWT_SECRET, { expiresIn: '30d' });
}
function tokenStillValid(decoded) {
  if (!decoded || decoded.userId == null) return false;
  const current = db.getTokenVersion(decoded.userId); // null = account deleted
  return current !== null && (decoded.tv ?? 0) === current;
}

// Log in to a specific gym through its provider adapter, which owns the URL,
// headers and login shape. Returns { session, profile, raw } — `raw` is the
// provider's own payload, so only provider-shaped callers should touch it.
//
// Renamed from loginToCodexFitAPI (WP-D7): a function named after one platform
// is how the next caller talks itself into assuming that platform.
async function loginToGym(gymId, email, password) {
  return getProvider(gymId).login({ email, password });
}

// BFF Login handler
async function handleLogin(email, password) {
  if (!email || !password) {
    throw new Error('Email and password are required');
  }

  // Development bypass: an email that is some gym's configured `devMock.email`
  // (gyms.config.js) logs in to the dev mocks. Never in production — outside dev
  // this branch used to accept any password for that address.
  const devGym = process.env.NODE_ENV === 'production' ? null : findDevMockGym(email);
  if (devGym) {
    const devToken = getProvider(devGym.id).mockToken;
    let user = db.getUserByEmail(email);
    let userId;
    const encryptedPassword = encrypt(password);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    const jwtExpiresAt = expiresAt.toISOString();

    // The account is gym-less on creation; the loop below links every enabled gym
    // (the dev email's own included) through linkGymAccount, which is explicit
    // about its gym. An existing dev account just refreshes its mock session.
    if (user) {
      userId = user.id;
      if (db.isGymLinked(userId, devGym.id)) {
        db.setGymSession(userId, devGym.id, { accessToken: devToken, expiresAt: jwtExpiresAt });
      }
    } else {
      // The bypass never checks a local password (any password logs in), so the
      // account gets an unguessable throwaway one — also sidesteps the policy minimum.
      userId = db.createAccount(email, crypto.randomBytes(16).toString('hex'));
    }

    // Seed EVERY enabled gym onto the dev account, not just the default one.
    //
    // The point of the dev environment is a true multi-gym account — merged
    // lists, colliding provider ids, per-row routing — and none of that is
    // exercisable from an account linked to one gym. Requiring a manual link
    // step meant the default dev experience was single-gym, which is the exact
    // shape the multi-gym work needs to stop assuming.
    //
    // Every login here is a MOCK login (mock.js / mock-marianatek.js). No live
    // gym is contacted and no real credential is stored. Failures are ignored on
    // purpose: a gym whose mock is unavailable must not block dev login.
    try {
      const { listEnabledGyms } = require('./gyms.config');
      for (const gym of listEnabledGyms()) {
        if (db.isGymLinked(userId, gym.id)) continue;
        // Aarmy is an opt-in tenant even in development: its config can be
        // enabled for manual mock onboarding, but automatic seeding stays off
        // unless the developer explicitly opts in. This also keeps the
        // default dev fixture aligned with Psycle + JAB.
        if (gym.id === 'aarmy' && process.env.AARMY_ENABLED !== 'true') continue;
        // Each gym declares its own mock identity (`devMock.email`); tenants on
        // one provider (JAB and Aarmy on MarianaTek) have separate ones. A gym
        // with none is not seeded.
        const gymEmail = gym.devMock && gym.devMock.email;
        if (!gymEmail) continue;
        try {
          await linkGymAccount(userId, gym.id, gymEmail, password);
          console.log(`[Dev] Linked ${gym.id} (${gym.provider} mock) to the dev account.`);
        } catch (err) {
          console.warn(`[Dev] Could not link ${gym.id}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn('[Dev] Gym seeding skipped:', err.message);
    }

    const localToken = signUserToken(userId, email);

    return {
      token: localToken,
      user: {
        id: 99999,
        email: email,
        firstName: 'Dev',
        lastName: 'User',
        bookingCutoff: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        extendedCutoff: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      }
    };
  }

  // --- the app account login (Decision D4) ---------------------------
  //
  // An app login is the account's OWN credential (scrypt hash), independent of any
  // gym: it authenticates locally, with no gym round-trip, so login stays up when a
  // gym's API is down or a membership lapses — which is the point of D4. The gym
  // session is NOT touched here; the first gym call triggers triggerAutoRelogin()
  // from the stored per-gym credential if the session has expired.
  //
  // There is deliberately NO gym-login fallback and no implicit account creation:
  // accounts exist only via signup (POST /api/auth/signup, gym-less), and a gym is
  // attached afterwards with POST /api/my-gyms/link. A failed password never falls
  // back to gym auth, or an old gym password would bypass a changed app password.
  const existing = db.getUserByEmail(email);
  if (!existing || !db.hasAccountPassword(existing.id)) {
    // Same scrypt cost as a real check, so response time does not reveal whether the
    // address has an account (login enumeration).
    db.burnPasswordCheck(password);
    throw new Error('Invalid email or password');
  }
  if (!db.verifyAccountPassword(existing.id, password)) throw new Error('Invalid email or password');
  const localToken = signUserToken(existing.id, email);
  // getUserById (not the bare getUserByEmail row) — profile_json/display_name live
  // in user_gyms since WP-D3, and this merges the active gym's link in.
  const merged = db.getUserById(existing.id) || existing;
  let profile = {};
  try { profile = merged.profile_json ? JSON.parse(merged.profile_json) : {}; } catch (_) {}
  const nameParts = (merged.display_name || '').split(' ');
  return {
    token: localToken,
    user: {
      id: profile.id || null,
      email: merged.email,
      firstName: profile.first_name || nameParts[0] || '',
      lastName: profile.last_name || nameParts.slice(1).join(' ') || '',
      bookingCutoff: profile.booking_cutoff || null,
      extendedCutoff: profile.extended_cutoff || null,
    },
  };
}

// Local auth middleware for PWA-to-server requests
// --- Per-request active-gym resolution (WP-C2) ---
//
// The client sends `x-gym-id` once the user has picked a gym (WP-C1). This is the
// ONLY place that header is trusted, and only after checking the account is
// actually linked to that gym — otherwise a caller could name any gym id and have
// db.js resolve another gym's session, credentials and calendar token for them.
// A header naming an unlinked gym is a 403, not a silent fallback: silently
// serving a different gym's data than the one asked for is the worse failure.
//
// With no header we establish no context at all, and db.resolveActiveGymId falls
// through to the user's stored choice / sole linked gym — which is exactly the
// old behaviour for every existing single-gym account.
function withGymContext(req, res, next) {
  const requested = req.headers['x-gym-id'];
  if (!requested) return next();
  if (!db.isGymLinked(req.userId, requested)) {
    return res.status(403).json({ message: `Account is not linked to gym "${requested}".` });
  }
  // Settings must remain reachable so a linked gym can be re-enabled. Other
  // stale gym-scoped requests must not fetch or mutate a disabled gym. The
  // attendance total is the one other exception: it answers a switched-off gym
  // from stored class history only (routes-normalized.js), never the provider.
  const settingsRequest = /^\/api\/(?:settings|attendance-totals)(?:\?|$)/.test(req.originalUrl || '');
  const connectionSettingsRequest = /^\/api\/settings(?:\?|$)/.test(req.originalUrl || '');
  if (!connectionSettingsRequest && require('./gym-connection').unavailable(req.userId, requested)) {
    return res.status(401).json({ code: 'GYM_SESSION_EXPIRED', gymId: requested, message: 'Log in to this gym again.' });
  }
  if (!settingsRequest && !db.isUserGymEnabled(req.userId, requested)) {
    return res.status(409).json({ code: 'GYM_DISABLED', message: 'This gym is turned off in Settings.' });
  }
  return db.runWithGymContext(req.userId, requested, next);
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Authorization token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || !tokenStillValid(decoded)) {
      return res.status(403).json({ message: 'Invalid or expired session token' });
    }
    req.userId = decoded.userId;
    req.email = decoded.email;
    // Stamp activity here rather than on any one route: this is the single
    // chokepoint every authenticated request passes through, regardless of which
    // gym or platform it targets. (db throttles the write to once per 5 min.)
    try { db.touchUserLastSeen(req.userId); } catch (_) {}
    withGymContext(req, res, next);
  });
}

// --- SSE tickets -------------------------------------------------------------
// EventSource cannot send an Authorization header, so the stream used to take the
// 30-day session JWT in the query string (access logs, history, Referer). Instead an
// authenticated POST /api/auth/sse-ticket mints a random single-use ticket valid for
// 60 s, held in memory (one process), consumed on first use. The legacy `?token=`
// path still works for ONE release so already-open tabs on an old bundle keep their
// live status line across the deploy; remove it next release.
const SSE_TICKET_TTL_MS = 60 * 1000;
const SSE_TICKET_MAX = 5000;
const SSE_TICKET_PER_USER = 10; // a user cannot exhaust the global cap and starve everyone else
const sseTickets = new Map(); // ticket -> { userId, email, gymId, expiresAt }

function mintSseTicket(req) {
  const now = Date.now();
  for (const [t, v] of sseTickets) if (v.expiresAt <= now) sseTickets.delete(t);
  if (sseTickets.size >= SSE_TICKET_MAX) return null;
  let mine = 0;
  for (const v of sseTickets.values()) if (v.userId === req.userId) mine++;
  if (mine >= SSE_TICKET_PER_USER) return null;
  const ticket = crypto.randomBytes(32).toString('base64url');
  sseTickets.set(ticket, { userId: req.userId, email: req.email, gymId: req.headers['x-gym-id'] || null, tv: db.getTokenVersion(req.userId), expiresAt: now + SSE_TICKET_TTL_MS });
  return { ticket, expiresInSec: SSE_TICKET_TTL_MS / 1000 };
}

function redeemSseTicket(ticket) {
  const entry = sseTickets.get(String(ticket));
  if (!entry) return null;
  sseTickets.delete(String(ticket)); // single use, valid or not
  if (entry.expiresAt <= Date.now()) return null;
  const current = db.getTokenVersion(entry.userId);
  if (current === null || current !== entry.tv) return null; // account deleted, or password changed/reset since minting
  return entry;
}

// SSE-compatible auth middleware: Authorization header, a single-use ?ticket=, or
// (legacy, one more release) the session JWT as ?token=.
function authenticateTokenSSE(req, res, next) {
  const ticket = req.query.ticket;
  if (ticket) {
    const entry = redeemSseTicket(ticket);
    if (!entry) return res.status(403).json({ message: 'Invalid or expired stream ticket' });
    req.userId = entry.userId;
    req.email = entry.email;
    if (entry.gymId && !req.headers['x-gym-id']) req.headers['x-gym-id'] = entry.gymId;
    return withGymContext(req, res, next);
  }

  let token = null;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }
  if (!token && req.query.token) {
    token = req.query.token; // LEGACY: remove next release
  }

  if (!token) {
    return res.status(401).json({ message: 'Authorization token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || !tokenStillValid(decoded)) {
      return res.status(403).json({ message: 'Invalid or expired session token' });
    }
    req.userId = decoded.userId;
    req.email = decoded.email;
    // NB: an SSE stream outlives its request context — writes from the scheduler's
    // timers later on resolve via the persisted path, not this one. Fine today
    // (auto-book rows carry their own gym_id); revisit under WP-S3.
    withGymContext(req, res, next);
  });
}

// C6-4: stop re-submitting a stored credential the gym keeps rejecting. Each
// background renewal is a real login against the member's own gym account; a bad
// password retried every minute by the scheduler/poller/calendar is how an
// upstream lockout happens. Only credential REJECTIONS count — a provider
// outage never suspends retries. Cleared by a successful renewal or a re-link.
const RELOGIN_MAX_REJECTIONS = 1;

// Renew a gym session when the stored one is rejected (401 Unauthorized).
const renewalFlights = new Map();
async function triggerAutoRelogin(userId, gymId = null) {
  const target = gymId || db.resolveActiveGymId(userId);
  const key = `${userId}:${target}`;
  if (renewalFlights.has(key)) return renewalFlights.get(key);
  const work = renewGymSession(userId, target).finally(() => renewalFlights.delete(key));
  renewalFlights.set(key, work);
  return work;
}
async function renewGymSession(userId, targetGymId) {
  const connection = require('./gym-connection');
  gymOutbound.assertOutboundAllowed(targetGymId, userId);
  const link = db.getUserGym(userId, targetGymId);
  if (!link) throw new Error('Gym is not linked.');
  if (link.status === 'needs_relogin' || link.relogin_suspended) throw connection.expiredError(targetGymId);
  let session = null;
  try { session = link.session_json ? JSON.parse(link.session_json) : null; } catch (_) {}
  let credentials = null;
  if (link.remember_login && link.gym_email && link.encrypted_password) {
    try { credentials = { email: link.gym_email, password: decrypt(link.encrypted_password) }; } catch (_) {}
  }
  try {
    const renewed = await getProvider(targetGymId).refreshSession(session, credentials);
    if (!renewed?.accessToken) throw Object.assign(new Error('Provider returned no session'), { code: 'GYM_AUTH_REQUIRED' });
    if (!db.commitGymRenewal(userId, targetGymId, renewed, link.connection_revision)) {
      const current = db.getUserSession(userId, targetGymId);
      if (current?.accessToken && db.getUserGym(userId, targetGymId)?.status === 'active') return current.accessToken;
      throw connection.expiredError(targetGymId);
    }
    return renewed.accessToken;
  } catch (err) {
    if (err.code === 'GYM_SESSION_EXPIRED') throw err;
    const latest = db.getUserGym(userId, targetGymId);
    if (latest?.connection_revision !== link.connection_revision) {
      const current = db.getUserSession(userId, targetGymId);
      if (current?.accessToken && latest.status === 'active') return current.accessToken;
      throw connection.expiredError(targetGymId);
    }
    db.recordReloginFailure(userId, targetGymId, { rejected: err.code === 'GYM_CREDENTIAL_REJECTED', error: err.code === 'GYM_CREDENTIAL_REJECTED' ? 'Gym rejected your login' : 'Session renewal unavailable', maxRejections: RELOGIN_MAX_REJECTIONS });
    // Adapters classify definitive auth failure; outages/429 never discard a session.
    const definitive = err.code === 'GYM_AUTH_REQUIRED' || err.code === 'GYM_CREDENTIAL_REJECTED';
    if (!definitive) throw err;
    throw connection.requireLogin(userId, targetGymId, err.code === 'GYM_CREDENTIAL_REJECTED' ? 'login_rejected' : 'session_expired', link.connection_revision);
  } finally { credentials = null; }
}

// --- the app account signup (Decision D4) ---------------------------
//
// Creates an account that has never had a gym. Before D4 this was impossible:
// an account could only be born by logging into CodexFit, which is precisely
// what made the account die with the membership. Gyms are linked afterwards
// via linkGymAccount().
async function handleSignup(email, password, acceptance) {
  require('./policies').validateAcceptance(acceptance);
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) throw new Error('A valid email address is required');
  if (!password || String(password).length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  if (db.getUserByEmail(clean)) {
    // Deliberately explicit rather than vague. This endpoint is rate-limited and
    // the app is single-tenant behind Cloudflare Access, so the enumeration risk
    // is not worth the "did it work?" confusion a generic message creates here.
    throw new Error('An account with that email already exists. Try logging in.');
  }

  const userId = db.db.transaction(() => {
    const id = db.createAccount(clean, password);
    db.recordPolicyAcceptance(id, acceptance);
    return id;
  })();
  const localToken = signUserToken(userId, clean);
  return {
    token: localToken,
    // U4-17: the real id, not null. The client keys per-account state (onboarding step/completion) on it;
    // with null it fell back to the email, so a reload re-keyed to the id and resume lost its place.
    user: { id: userId, email: clean, firstName: '', lastName: '', bookingCutoff: null, extendedCutoff: null },
    needsGym: true, // the client sends them straight to "link a gym"
  };
}

// --- Account recovery ------------------------------------------------------
//
// REMOVED 2026-08-31: recovery previously worked by proving a LINKED GYM'S login.
// Rejected by the stakeholder, and rightly — it re-coupled the account to the gym,
// which is precisely what Decision D4 exists to break:
//   * cancel the membership and you lose the ability to recover the account;
//   * the gym password becomes a permanent master key for the the app
//     account, so a weak or reused gym password (and the gym's own security
//     posture, which we do not control) silently becomes the account's floor;
//   * it made the "independent identity" claim untrue in the one moment that
//     matters most.
//
// No replacement is wired yet — the mechanism is an open decision, see
// Documentation/Workstreams/C6-accounts-auth.md. Until one lands, a forgotten account
// password needs an admin reset.
//
// `db.resetGymCredentials()` survives and should be called by whatever mechanism
// replaces this: the stakeholder's "recovery resets gym credentials" decision is
// independent of HOW identity gets proven. With the gym no longer part of the
// proof, there is no longer a "gym we just verified" to carve out — recovery now
// resets ALL of them.

// Link a gym to an existing the app account, or re-authenticate one whose
// stored credential has gone stale (the user changed their password at the gym).
// Deliberately ONE function for both: "link" and "re-auth" are the same operation
// — prove the credential against the provider, then store it — and splitting them
// would mean two places that can drift on how a session is persisted.
//
// Credentials are only ever stored AFTER the provider accepts them, so a failed
// attempt cannot overwrite a working link.
async function linkGymAccount(userId, gymId, email, password, rememberLogin = false) {
  if (typeof rememberLogin !== 'boolean') throw new Error('rememberLogin must be a boolean');
  const existingLink = db.getUserGym(userId, gymId);
  const revision = existingLink?.connection_revision ?? null;
  if (!gymId || !email || !password) {
    throw new Error('gymId, email and password are required');
  }
  const gym = db.getGym(gymId);
  if (!gym) throw new Error(`Unknown gym "${gymId}".`);
  if (!gym.enabled) throw new Error(`Gym "${gymId}" is not available yet.`);

  const provider = getProvider(gymId);
  const { session, profile } = await require('./gym-connection').withRecovery(userId, gymId, () => provider.login({ email, password }));
  if (!session || !session.accessToken) {
    throw new Error('Gym login did not return a session');
  }

  const recovering = existingLink && existingLink.status !== 'active';
  const committed = db.commitGymLogin(userId, gymId, {
    // Store the email alongside the password — both were just proven against this
    // gym, and without it nothing can re-authenticate unattended for any account
    // whose gym login differs from its the app login (WP-D5). Lower-cased
    // (as handleSignup does for the SA email) so a re-link differing only in case
    // updates the link rather than reading as a different identity.
    gym_email: rememberLogin ? String(email).trim().toLowerCase() : null,
    encrypted_password: rememberLogin ? encrypt(password) : null,
    session_json: JSON.stringify(require('./policies').sessionMaterial(session)),
    display_name: profile && [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null,
    profile_json: profile && profile.raw ? JSON.stringify(require('./policies').withoutLoginDetails(profile.raw)) : null,
    profile_synced_at: new Date().toISOString(),
    // The credential was just proven against the gym — this is the one place
    // (with setGymSession) that may stamp it. Surfaced in Settings as the
    // connection's "last authenticated" date.
    last_authenticated_at: new Date().toISOString(),
    // Preserve an existing link's priority tier and calendar token on re-auth —
    // re-authenticating must not silently demote someone or break their feed URL.
    priority: existingLink ? existingLink.priority : 200,
    calendar_token: existingLink ? existingLink.calendar_token : null,
    status: recovering ? 'syncing' : 'active',
  }, rememberLogin, revision);
  if (!committed) throw new Error('Gym connection changed while signing in. Please try again.');
  if (recovering) {
    const result = await require('./gym-connection').withRecovery(userId, gymId, () => require('./booking-sync').syncUserGym(userId, gymId, { force: true }));
    if (!result.ok) throw new Error('Gym login succeeded. Fresh syncing is still pending; your gym remains paused.');
    const current = db.getUserGym(userId, gymId);
    db.finishGymReconnect(userId, gymId, current.connection_revision);
    require('./calendar').regenerateSnapshot(userId);
  }
  return db.getUserGymsPublic(userId).find((g) => g.gym_id === gymId);
}

// Unlink a gym. The the app account itself survives — that is the whole
// point of Decision D4: cancelling a Psycle membership must not cost you JAB.
// Unlinking the last gym is allowed for the same reason; the account remains and
// can link a different gym later.
function unlinkGymAccount(userId, gymId) {
  if (!db.isGymLinked(userId, gymId)) throw new Error(`Account is not linked to gym "${gymId}".`);
  db.unlinkGym(userId, gymId);
  return db.getUserGymsPublic(userId);
}

module.exports = {
  handleLogin,
  handleSignup,
  authenticateToken,
  authenticateTokenSSE,
  mintSseTicket,
  signUserToken,
  _sseTicketCount: () => sseTickets.size,
  triggerAutoRelogin,
  RELOGIN_MAX_REJECTIONS,
  linkGymAccount,
  unlinkGymAccount,
};
