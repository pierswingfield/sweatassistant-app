// F-15 — unauthenticated, same-origin instructor WebP endpoint.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { getProvider } = require('./providers');
const { getGymConfig } = require('./gyms.config');
const photos = require('./instructor-photo');

const router = express.Router();
const photoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many instructor-photo requests — please try again shortly.' },
  skip: () => process.env.NODE_ENV !== 'production' && process.env.RATE_LIMIT_TEST_FORCE !== '1',
});

router.get('/instructor-photo/:gymId/:instructorId', photoLimiter, async (req, res) => {
  const { gymId, instructorId } = req.params;
  const variant = req.query.size === 'full' ? 'full' : (req.query.size === 'thumb' ? 'thumb' : null);
  const version = typeof req.query.v === 'string' ? req.query.v : '';
  if (!getGymConfig(gymId) || !/^[A-Za-z0-9_-]{1,128}$/.test(instructorId) || !variant) return res.status(404).end();

  const result = await photos.getPhoto({ provider: getProvider(gymId), instructorId, variant, version });
  if (!result) return res.status(404).end();
  const { body, cacheStatus } = result;
  const etag = `"${version}-${variant}"`;
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).set({
      ETag: etag,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Instructor-Photo-Cache': cacheStatus,
    }).end();
  }
  res.set({
    'Content-Type': 'image/webp',
    'Content-Length': String(body.length),
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'X-Instructor-Photo-Cache': cacheStatus,
    'X-Content-Type-Options': 'nosniff',
  });
  res.send(body);
});

module.exports = router;
