'use strict';

const crypto = require('crypto');

/**
 * CSRF token per sesi (synchronizer token). Disimpan di session server,
 * dikirim oleh client via header X-CSRF-Token atau field _csrf.
 * SameSite cookie saja TIDAK dianggap cukup — token tetap divalidasi server.
 */

const HEADER = 'x-csrf-token';
const BODY_FIELD = '_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function newCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Pastikan sesi punya token CSRF; simpan di res.locals untuk dipakai view. */
function attachCsrfToken(req, res, next) {
  if (req.session && !req.session.csrfToken) {
    req.session.csrfToken = newCsrfToken();
  }
  res.locals.csrfToken = req.session ? req.session.csrfToken : null;
  next();
}

/** Guard untuk semua metode state-changing (POST/PUT/PATCH/DELETE). */
function requireCsrfToken(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const sessionToken = req.session && req.session.csrfToken;
  const provided = (req.get(HEADER) || (req.body && req.body[BODY_FIELD]) || '').toString();
  if (!sessionToken || !provided || !crypto.timingSafeEqual
    || provided.length !== sessionToken.length
    || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(sessionToken))) {
    return res.status(403).json({ ok: false, error: 'CSRF token tidak valid.' });
  }
  return next();
}

function rotateCsrfToken(req) {
  if (req.session) req.session.csrfToken = newCsrfToken();
  return req.session ? req.session.csrfToken : null;
}

module.exports = { attachCsrfToken, requireCsrfToken, rotateCsrfToken, newCsrfToken, HEADER, BODY_FIELD };
