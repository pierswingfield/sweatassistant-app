const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('./db');

const router = express.Router();

// Admin auth uses the same JWT_SECRET as user auth but requires { admin: true } in the payload.
// ADMIN_PASSWORD must be set in the environment; if absent all admin routes return 503.
const JWT_SECRET = (() => {
  let s = process.env.JWT_SECRET;
  if (!s) {
    s = db.getKV('jwt_secret');
    if (!s) { s = require('crypto').randomBytes(32).toString('hex'); db.setKV('jwt_secret', s); }
  }
  return s;
})();

function adminUnavailable(res) {
  return res.status(503).json({ message: 'Admin access is not configured (ADMIN_PASSWORD not set).' });
}

function authenticateAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) return adminUnavailable(res);

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Admin token required.' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err || !decoded.admin) return res.status(403).json({ message: 'Invalid or expired admin session.' });
    next();
  });
}

// POST /api/admin/login — verify ADMIN_PASSWORD, issue admin JWT (1h)
router.post('/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return adminUnavailable(res);
  const { password } = req.body;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ message: 'Invalid admin password.' });
  }
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '1h' });
  res.json({ token });
});

// GET /api/admin/users — list all users with queue counts
router.get('/users', authenticateAdmin, (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /api/admin/users/:id/priority — update a user's priority tier
router.put('/users/:id/priority', authenticateAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  const priority = parseInt(req.body.priority, 10);
  if (isNaN(userId) || isNaN(priority) || priority < 1 || priority > 999) {
    return res.status(400).json({ message: 'Priority must be an integer between 1 and 999.' });
  }
  try {
    db.setUserPriority(userId, priority);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /api/admin/users/:id — delete user + all their data (CASCADE handles related rows)
router.delete('/users/:id', authenticateAdmin, (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ message: 'Invalid user ID.' });
  try {
    db.deleteUser(userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
