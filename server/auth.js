const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('./db');
const { encrypt, decrypt } = require('./crypto');

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

// Native fetch call to login directly to CodexFit
async function loginToCodexFitAPI(email, password) {
  const url = 'https://psycle.codexfit.com/api/v1/customer/auth/login';
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'origin': 'https://psyclelondon.com',
      'referer': 'https://psyclelondon.com/',
      'x-organisation': '[object Object]'
    },
    body: JSON.stringify({ email, password })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Login failed with status ${response.status}`);
  }

  return response.json(); // returns { access_token, user: { ... } }
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

    if (user) {
      userId = user.id;
      db.updateUserCredentials(userId, encryptedPassword, 'mock-jwt-token', jwtExpiresAt);
    } else {
      userId = db.createUser(email, encryptedPassword);
      db.updateUserJWT(userId, 'mock-jwt-token', jwtExpiresAt);
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

  // 1. Authenticate with CodexFit
  const data = await loginToCodexFitAPI(email, password);
  console.log('[Auth] CodexFit login response keys:', Object.keys(data));
  if (data.user) {
    console.log('[Auth] data.user keys:', Object.keys(data.user));
  } else {
    // Safely log structure without leaking access_token
    const safeData = { ...data };
    if (safeData.access_token) safeData.access_token = '***';
    console.log('[Auth] data.user is undefined. Full response structure:', JSON.stringify(safeData));
  }
  const codexToken = data.access_token;
  const codexUser = data.user || data.customer || data.data || {};

  // 2. Encrypt password for automatic re-login
  const encryptedPassword = encrypt(password);

  // Set JWT expiry for local DB tracking (CodexFit cookies are 365 days)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 365);
  const jwtExpiresAt = expiresAt.toISOString();

  // 3. Store in DB
  let user = db.getUserByEmail(email);
  let userId;
  if (user) {
    userId = user.id;
    db.updateUserCredentials(userId, encryptedPassword, codexToken, jwtExpiresAt);
  } else {
    userId = db.createUser(email, encryptedPassword);
    db.updateUserJWT(userId, codexToken, jwtExpiresAt);
  }

  // 3b. Cache display name for admin panel (best-effort — don't fail login if this errors)
  const displayName = [codexUser.first_name, codexUser.last_name].filter(Boolean).join(' ');
  if (displayName) {
    try { db.updateUserDisplayName(userId, displayName); } catch (_) {}
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
      id: codexUser.id || null,
      email: codexUser.email || email,
      firstName: codexUser.first_name || '',
      lastName: codexUser.last_name || '',
      bookingCutoff: codexUser.booking_cutoff || null,
      extendedCutoff: codexUser.extended_cutoff || null
    }
  };
}

// Local auth middleware for PWA-to-server requests
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
    next();
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
    next();
  });
}

// Auto-relogin when stored CodexFit JWT fails (401 Unauthorized)
async function triggerAutoRelogin(userId) {
  console.log(`[Auth] CodexFit token expired for user ${userId}. Attempting automatic re-login...`);
  const user = db.getUserById(userId);
  if (!user) {
    throw new Error('User not found');
  }

  try {
    const password = decrypt(user.encrypted_password);
    const data = await loginToCodexFitAPI(user.email, password);
    const newCodexToken = data.access_token;

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 365);
    const jwtExpiresAt = expiresAt.toISOString();

    db.updateUserJWT(userId, newCodexToken, jwtExpiresAt);
    console.log(`[Auth] Automatic re-login successful for user ${userId}.`);
    return newCodexToken;
  } catch (err) {
    console.error(`[Auth] Automatic re-login failed for user ${userId}:`, err.message);
    // Clear invalid token in DB so we don't loop indefinitely
    db.updateUserJWT(userId, null, null);
    throw new Error('Automatic session renewal failed. Please log in again.');
  }
}

module.exports = {
  handleLogin,
  authenticateToken,
  authenticateTokenSSE,
  triggerAutoRelogin
};
