const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { getProvider } = require('./providers');

// The gym a BRAND-NEW account bootstraps against via the legacy email+password
// login path (handleLogin). It is not a general fallback and must not be used as
// one: an existing account resolves its OWN gym, and the modern path is signup
// (gym-less) + POST /api/my-gyms/link. See handleLogin's note below.
const { DEFAULT_GYM_ID } = require('./gyms.config');

const JWT_SECRET = getJWTSecret();

function getJWTSecret() {
  let secret = process.env.JWT_SECRET;
  if (!secret) {
    secret = db.getKV('jwt_secret');
    if (!secret) {
      secret = crypto.randomBytes(32).toString('hex');
      db.setKV('jwt_secret', secret);
    }
  }
  return secret;
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

  // Development bypass check
  if (email === 'dev@psycle.com') {
    let user = db.getUserByEmail(email);
    let userId;
    const encryptedPassword = encrypt(password);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    const jwtExpiresAt = expiresAt.toISOString();

    // dev@psycle.com's own mock login is always psycle-london — the loop below
    // separately links every other enabled gym via linkGymAccount, which is
    // already explicit about its own gym.
    if (user) {
      userId = user.id;
      db.updateUserCredentials(userId, encryptedPassword, 'mock-jwt-token', jwtExpiresAt, DEFAULT_GYM_ID);
    } else {
      userId = db.createUser(email, encryptedPassword);
      db.updateUserJWT(userId, 'mock-jwt-token', jwtExpiresAt, DEFAULT_GYM_ID);
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
      const DEV_LOGIN_BY_PROVIDER = {
        codexfit: 'dev@psycle.com',
        marianatek: 'dev@jabboxing.mock',
      };
      for (const gym of listEnabledGyms()) {
        if (db.isGymLinked(userId, gym.id)) continue;
        // Aarmy is an opt-in tenant even in development: its config can be
        // enabled for manual mock onboarding, but automatic seeding stays off
        // unless the developer explicitly opts in. This also keeps the
        // default dev fixture aligned with Psycle + JAB.
        if (gym.id === 'aarmy' && process.env.AARMY_ENABLED !== 'true') continue;
        // Tenants on one provider may have separate mock identities (for
        // example JAB and Aarmy both use MarianaTek). Prefer the gym's own
        // configured mock account, falling back to the provider default only
        // for older configs that do not declare one.
        const gymEmail = gym.mockEmail || DEV_LOGIN_BY_PROVIDER[gym.provider];
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

    const localToken = jwt.sign(
      { userId, email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

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

  // --- Sweat Assistant account login (Decision D4) ---------------------------
  //
  // An SA login used to BE a gym login: it round-tripped CodexFit every time, and
  // the account only existed as long as the membership did. Now the SA credential
  // is its own thing, so:
  //   * a migrated account authenticates locally — no gym round-trip, so login
  //     stays up (and fast) even when the gym's API is down or the membership
  //     lapses, which is the entire point of D4;
  //   * the gym session is NOT refreshed here. It doesn't need to be — the first
  //     proxied call triggers triggerAutoRelogin() from the stored per-gym
  //     credential if the session has expired.
  //
  // Existing accounts have no password_hash yet. They fall through to the gym
  // login below, which sets one from the password they just proved they know —
  // a silent migration, no forced reset, no user-visible step.
  const existing = db.getUserByEmail(email);
  if (existing && db.hasAccountPassword(existing.id)) {
    if (!db.verifyAccountPassword(existing.id, password)) {
      // Deliberately NOT falling back to gym auth on failure: once someone has
      // changed their SA password, their old gym password must stop working as a
      // way in, or the change was decorative.
      throw new Error('Invalid email or password');
    }
    const localToken = jwt.sign({ userId: existing.id, email }, JWT_SECRET, { expiresIn: '30d' });
    // getUserById (not the bare getUserByEmail row) — profile_json/display_name
    // live in user_gyms since WP-D3, and this merges the active gym's link in.
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

  // 1. Authenticate against the gym.
  //
  // Which gym? An account that already exists resolves its OWN — assuming Psycle
  // here would send a JAB-only user's credentials to the wrong provider. Only a
  // genuinely new account has nothing to resolve from, and bootstraps against the
  // default gym. That bootstrap is the LEGACY path, kept so existing single-gym
  // users can keep signing in with one form; the modern flow is signup (gym-less)
  // then POST /api/my-gyms/link, which names its gym explicitly.
  const loginGymId = existing ? db.resolveActiveGymId(existing.id) : DEFAULT_GYM_ID;
  const { session: gymSession, raw: data } = await loginToGym(loginGymId, email, password);
  console.log(`[Auth] Login response from ${loginGymId}, keys:`, Object.keys(data || {}));
  if (data.user) {
    console.log('[Auth] data.user keys:', Object.keys(data.user));
  } else {
    // Safely log structure without leaking access_token
    const safeData = { ...data };
    if (safeData.access_token) safeData.access_token = '***';
    console.log('[Auth] data.user is undefined. Full response structure:', JSON.stringify(safeData));
  }
  const gymToken = gymSession.accessToken;
  const gymUser = data.user || data.customer || data.data || {};

  // 2. Encrypt password for automatic re-login
  const encryptedPassword = encrypt(password);

  // Set JWT expiry for local DB tracking (CodexFit cookies are 365 days)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 365);
  const jwtExpiresAt = expiresAt.toISOString();

  // 3. Store in DB
  let user = db.getUserByEmail(email);
  let userId;
  // Named explicitly with the SAME gym `loginGymId` already resolved above —
  // letting this re-resolve independently risked landing on a different answer
  // than the gym the login actually authenticated against.
  if (user) {
    userId = user.id;
    db.updateUserCredentials(userId, encryptedPassword, gymToken, jwtExpiresAt, loginGymId);
  } else {
    userId = db.createUser(email, encryptedPassword);
    db.updateUserJWT(userId, gymToken, jwtExpiresAt, loginGymId);
  }

  // 3a. Adopt this password as the Sweat Assistant account password (Decision D4).
  // The user just proved they know it against the gym, so it is safe to seed from
  // — and it means every existing account migrates to an independent identity on
  // its next login with no prompt. Best-effort: a hashing failure must not cost
  // someone their login.
  if (!db.hasAccountPassword(userId)) {
    try { db.setAccountPassword(userId, password); } catch (err) {
      console.warn('[Auth] Could not seed account password:', err.message);
    }
  }

  // 3b. Cache display name for admin panel (best-effort — don't fail login if this errors)
  const displayName = [gymUser.first_name, gymUser.last_name].filter(Boolean).join(' ');
  if (displayName) {
    try { db.updateUserDisplayName(userId, displayName, loginGymId); } catch (_) {}
  }

  // 4. Issue local signed JWT token for the PWA
  const localToken = jwt.sign(
    { userId, email },
    JWT_SECRET,
    { expiresIn: '30d' } // PWA session lasts 30 days before requiring CF Access / login again
  );

  return {
    token: localToken,
    user: {
      id: gymUser.id || null,
      email: gymUser.email || email,
      firstName: gymUser.first_name || '',
      lastName: gymUser.last_name || '',
      bookingCutoff: gymUser.booking_cutoff || null,
      extendedCutoff: gymUser.extended_cutoff || null
    }
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
  return db.runWithGymContext(req.userId, requested, next);
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ message: 'Authorization token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
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

// SSE-compatible auth middleware (accepts token in Authorization header or URL query param)
function authenticateTokenSSE(req, res, next) {
  let token = null;

  // Try Authorization header first
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

  // Fall back to query parameter for EventSource compatibility
  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ message: 'Authorization token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
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
const RELOGIN_MAX_REJECTIONS = 3;
const isCredentialRejection = (err) => /rejected your login|incorrect email\/password|invalid credentials/i.test((err && err.message) || '');

// Renew a gym session when the stored one is rejected (401 Unauthorized).
async function triggerAutoRelogin(userId, gymId = null) {
  // `gymId` is explicit for background callers (WP-D7). The scheduler, poller and
  // calendar cron all process rows that may belong to a gym the user is NOT
  // currently looking at; resolving the active gym here would renew the wrong
  // session and leave the row's own gym permanently expired. Request-path callers
  // omit it and get the active gym, which is what they want.
  const targetGymId = gymId || db.resolveActiveGymId(userId);
  const gymName = (db.getGym(targetGymId) || {}).name || targetGymId;
  console.log(`[Auth] Session expired for user ${userId} at ${gymName}. Attempting renewal...`);

  const link = db.getUserGym(userId, targetGymId);
  if (!link) {
    throw new Error(`Account is not linked to gym "${targetGymId}".`);
  }

  let session = null;
  try { session = link.session_json ? JSON.parse(link.session_json) : null; } catch (_) {}

  // Credentials for the ladder's re-login rung. `gym_email` is the address proven
  // against THIS gym (WP-D5) — deliberately not users.email, which is the Sweat
  // Assistant identity and may be a different address entirely.
  let credentials = null;
  if (link.gym_email && link.encrypted_password) {
    try {
      credentials = { email: link.gym_email, password: decrypt(link.encrypted_password) };
    } catch (err) {
      console.warn(`[Auth] Could not decrypt stored credential for user ${userId} at ${targetGymId}:`, err.message);
    }
  }

  if (!session && !credentials) {
    db.setUserGymStatus(userId, targetGymId, 'needs_relogin');
    // C1-2: carry the same status/code/gymId a route-level "no session" 401
    // carries (routes-normalized.js resolveContext), so a relogin that fails
    // mid-request surfaces to the client as a per-gym signal instead of an
    // opaque 500 that the 401 handler never even sees.
    const err = new Error(`No stored credential for ${gymName}. Please re-link the gym.`);
    err.status = 401;
    err.code = 'GYM_SESSION_EXPIRED';
    err.gymId = targetGymId;
    throw err;
  }

  // C6-4: suspended after repeated rejections — fail fast without contacting the gym.
  if (link.relogin_suspended) {
    const err = new Error(`Automatic sign-in to ${gymName} is paused after repeated failures. Please log in to that gym again.`);
    err.status = 401;
    err.code = 'GYM_SESSION_EXPIRED';
    err.gymId = targetGymId;
    err.reloginSuspended = true;
    throw err;
  }

  try {
    // The adapter owns the ladder — refresh token first where the platform has
    // one (MarianaTek), straight to re-login where it does not (CodexFit). The
    // caller deliberately does not know which, and must not: branching on the
    // platform here is how "MarianaTek as an extension of CodexFit" creeps back.
    const renewed = await getProvider(targetGymId).refreshSession(session, credentials);
    if (!renewed || !renewed.accessToken) {
      throw new Error('Provider returned no access token');
    }
    db.setGymSession(userId, targetGymId, renewed);
    db.setUserGymStatus(userId, targetGymId, 'active');
    db.clearReloginFailures(userId, targetGymId);
    console.log(`[Auth] Session renewed for user ${userId} at ${gymName}.`);
    return renewed.accessToken;
  } catch (err) {
    console.error(`[Auth] Session renewal failed for user ${userId} at ${gymName}:`, err.message);
    // Clear the dead session so callers stop retrying it in a loop, and flag the
    // link so the UI can prompt a re-link. The link itself SURVIVES: unlinking on
    // a transient provider outage would cost the user their queue, spot maps and
    // calendar token (Decision D4 — the account outlives the gym).
    db.setGymSession(userId, targetGymId, null);
    db.setUserGymStatus(userId, targetGymId, 'needs_relogin');
    const counters = db.recordReloginFailure(userId, targetGymId, {
      rejected: isCredentialRejection(err),
      error: err.message,
      maxRejections: RELOGIN_MAX_REJECTIONS,
    });
    if (counters && counters.relogin_suspended) {
      console.warn(`[Auth] ${gymName} rejected user ${userId}'s stored credential ${counters.relogin_rejections} times — automatic sign-in suspended until they re-link.`);
    }
    const relErr = new Error(`Could not renew your ${gymName} session. Please log in to that gym again.`);
    relErr.status = 401;
    relErr.code = 'GYM_SESSION_EXPIRED';
    relErr.gymId = targetGymId;
    throw relErr;
  }
}

// --- Sweat Assistant account signup (Decision D4) ---------------------------
//
// Creates an account that has never had a gym. Before D4 this was impossible:
// an account could only be born by logging into CodexFit, which is precisely
// what made the account die with the membership. Gyms are linked afterwards
// via linkGymAccount().
async function handleSignup(email, password) {
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

  const userId = db.createAccount(clean, password);
  const localToken = jwt.sign({ userId, email: clean }, JWT_SECRET, { expiresIn: '30d' });
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
//   * the gym password becomes a permanent master key for the Sweat Assistant
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

// Link a gym to an existing Sweat Assistant account, or re-authenticate one whose
// stored credential has gone stale (the user changed their password at the gym).
// Deliberately ONE function for both: "link" and "re-auth" are the same operation
// — prove the credential against the provider, then store it — and splitting them
// would mean two places that can drift on how a session is persisted.
//
// Credentials are only ever stored AFTER the provider accepts them, so a failed
// attempt cannot overwrite a working link.
async function linkGymAccount(userId, gymId, email, password) {
  if (!gymId || !email || !password) {
    throw new Error('gymId, email and password are required');
  }
  const gym = db.getGym(gymId);
  if (!gym) throw new Error(`Unknown gym "${gymId}".`);
  if (!gym.enabled) throw new Error(`Gym "${gymId}" is not available yet.`);

  const provider = getProvider(gymId);
  const { session, profile } = await provider.login({ email, password });
  if (!session || !session.accessToken) {
    throw new Error('Gym login did not return a session');
  }

  const existingLink = db.getUserGym(userId, gymId);
  db.upsertUserGym(userId, gymId, {
    // Store the email alongside the password — both were just proven against this
    // gym, and without it nothing can re-authenticate unattended for any account
    // whose gym login differs from its Sweat Assistant login (WP-D5). Lower-cased
    // (as handleSignup does for the SA email) so a re-link differing only in case
    // updates the link rather than reading as a different identity.
    gym_email: String(email).trim().toLowerCase(),
    encrypted_password: encrypt(password),
    session_json: JSON.stringify(session),
    display_name: profile && [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null,
    profile_json: profile && profile.raw ? JSON.stringify(profile.raw) : null,
    profile_synced_at: new Date().toISOString(),
    // The credential was just proven against the gym — this is the one place
    // (with setGymSession) that may stamp it. Surfaced in Settings as the
    // connection's "last authenticated" date.
    last_authenticated_at: new Date().toISOString(),
    // Preserve an existing link's priority tier and calendar token on re-auth —
    // re-authenticating must not silently demote someone or break their feed URL.
    priority: existingLink ? existingLink.priority : 200,
    calendar_token: existingLink ? existingLink.calendar_token : null,
    status: 'active',
  });
  db.clearReloginFailures(userId, gymId); // fresh credential just proven (C6-4)
  return db.getUserGymsPublic(userId).find((g) => g.gym_id === gymId);
}

// Unlink a gym. The Sweat Assistant account itself survives — that is the whole
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
  triggerAutoRelogin,
  RELOGIN_MAX_REJECTIONS,
  linkGymAccount,
  unlinkGymAccount,
};
