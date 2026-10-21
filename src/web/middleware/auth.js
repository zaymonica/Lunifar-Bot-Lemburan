'use strict';

/** Middleware autentikasi Web Admin berbasis session server-side. */

function isAuthenticated(req) {
  return !!(req.session && req.session.userId);
}

/** Untuk endpoint JSON: 401 tanpa sesi. Tidak membocorkan detail. */
function requireApiAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: 'Autentikasi diperlukan.' });
  }
  return next();
}

/** Untuk halaman HTML: redirect ke login tanpa sesi. */
function requirePageAuth(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.redirect(302, '/web/login');
  }
  return next();
}

module.exports = { isAuthenticated, requireApiAuth, requirePageAuth };
