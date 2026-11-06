// T-1 Teams API (PLAN-teams.md §7.4). Thin HTTP layer: every rule (who may do what,
// limits, 404-not-403, what a payload may contain) lives in teams.js.
//
// Status mapping comes from TeamError: NOT_FOUND 404 for anything a non-member could use
// to probe (unknown Team, not a member, bad/rotated/disabled token), 403 only for a
// member asking for a Captain action on their own Team.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { authenticateToken } = require('./auth');
const teams = require('./teams');

const router = express.Router();

const limiterOn = () => process.env.NODE_ENV === 'production' || process.env.RATE_LIMIT_TEST_FORCE === '1';

// Invite endpoints are the only Teams surface reachable with a guessed secret, so they
// get two budgets (§7.4). Per IP, before auth: also covers the public /t/:token shell.
// Uses the library's default IP keyGenerator (correct IPv6 handling in v8).
const inviteIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: 'Too many invite requests. Please try again later.' },
  skip: () => !limiterOn(),
});
// Per account, after auth. A real join is a handful of calls (open, preview, request).
const inviteAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? `u:${req.userId}` : ipKeyGenerator(req.ip)),
  message: { code: 'RATE_LIMITED', message: 'Too many invite requests. Please try again later.' },
  skip: () => !limiterOn(),
});

function handle(fn, okStatus = 200) {
  return (req, res) => {
    try {
      res.status(okStatus).json(fn(req));
    } catch (err) {
      if (err instanceof teams.TeamError) return res.status(err.status).json({ code: err.code, message: err.message });
      console.error('[Teams] unexpected error:', err && err.message);
      res.status(500).json({ message: 'Something went wrong.' });
    }
  };
}

const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

// Invite routes first: '/teams/invite/:token' must not be read as '/teams/:id'.
router.get('/teams/invite/:token', inviteIpLimiter, authenticateToken, inviteAccountLimiter,
  handle((req) => teams.previewInvite(req.userId, req.params.token)));
router.post('/teams/invite/:token/request', inviteIpLimiter, authenticateToken, inviteAccountLimiter,
  handle((req) => teams.requestJoin(req.userId, req.params.token, body(req).share)));
router.delete('/teams/invite/:token/request', inviteIpLimiter, authenticateToken, inviteAccountLimiter,
  handle((req) => teams.withdrawRequest(req.userId, req.params.token)));

// Before '/teams/:id' routes: '/teams/requests/me' must not be read as '/teams/:id/me'.
router.delete('/teams/requests/:requestId', authenticateToken,
  handle((req) => teams.withdrawRequestById(req.userId, req.params.requestId)));

// T-2: ?tz=<IANA zone> is the device's zone for "today" (validated; else the first gym's).
const tzOf = (req) => (typeof req.query.tz === 'string' ? req.query.tz.slice(0, 64) : undefined);
router.get('/teams', authenticateToken, handle((req) => ({ teams: teams.listTeams(req.userId, { zone: tzOf(req) }) })));
router.post('/teams', authenticateToken, handle((req) => teams.createTeam(req.userId, body(req)), 201));
// T-5: the timetable's Team chips, for every Team the viewer is in, in one call. Registered
// before '/teams/:id' so 'timetable' is never read as a Team id.
router.get('/teams/timetable', authenticateToken, handle((req) => teams.timetableChips(req.userId)));
router.get('/teams/:id', authenticateToken, handle((req) => teams.getTeam(req.userId, req.params.id)));
router.get('/teams/:id/today', authenticateToken, handle((req) => teams.getTeamToday(req.userId, req.params.id, { zone: tzOf(req) })));
router.patch('/teams/:id', authenticateToken, handle((req) => teams.updateTeam(req.userId, req.params.id, body(req))));
router.delete('/teams/:id', authenticateToken, handle((req) => teams.deleteTeam(req.userId, req.params.id)));

router.post('/teams/:id/invite/rotate', authenticateToken, handle((req) => teams.rotateInvite(req.userId, req.params.id)));
router.get('/teams/:id/invite', authenticateToken, handle((req) => teams.getInvite(req.userId, req.params.id)));
router.put('/teams/:id/invite', authenticateToken,
  handle((req) => teams.setInviteEnabled(req.userId, req.params.id, body(req).enabled)));

router.get('/teams/:id/requests', authenticateToken,
  handle((req) => ({ requests: teams.listRequests(req.userId, req.params.id) })));
router.post('/teams/:id/requests/:rid', authenticateToken,
  handle((req) => teams.decideRequest(req.userId, req.params.id, req.params.rid, body(req).decision)));

router.put('/teams/:id/me', authenticateToken, handle((req) => teams.updateMe(req.userId, req.params.id, body(req))));
router.put('/teams/:id/pin', authenticateToken, handle((req) => teams.setPinned(req.userId, req.params.id, body(req).pinned)));
router.delete('/teams/:id/me', authenticateToken, handle((req) => teams.leaveTeam(req.userId, req.params.id)));

router.put('/teams/:id/members/:memberRef', authenticateToken,
  handle((req) => teams.setCaptain(req.userId, req.params.id, req.params.memberRef, body(req).captain)));
router.delete('/teams/:id/members/:memberRef', authenticateToken,
  handle((req) => teams.removeMember(req.userId, req.params.id, req.params.memberRef, { block: body(req).block === undefined ? false : body(req).block })));

router.get('/privacy/sharing', authenticateToken, handle((req) => teams.privacyOverview(req.userId)));

module.exports = { router, inviteIpLimiter };
