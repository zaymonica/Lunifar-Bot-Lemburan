'use strict';

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { requireApiAuth } = require('../middleware/auth');
const { rotateCsrfToken } = require('../middleware/csrf');

const VIEWS_DIR = path.join(__dirname, '..', '..', '..', 'public', 'admin');
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,64}$/;
const BCRYPT_COST = 12;

function safeRead(file) {
  // Path tetap (bukan dari input user) — tidak ada pembacaan file arbitrer.
  const full = path.join(VIEWS_DIR, file);
  if (!full.startsWith(VIEWS_DIR)) throw new Error('Path view tidak valid.');
  return fs.readFileSync(full, 'utf8');
}

function renderLogin(res, csrfToken) {
  const html = safeRead('login.html').replace('__CSRF_TOKEN__', csrfToken);
  res.type('html').send(html);
}

function renderDashboard(res, csrfToken) {
  const html = safeRead('dashboard.html').replace('__CSRF_TOKEN__', csrfToken);
  res.type('html').send(html);
}

/** Validasi kredensial dengan mockable accountStore. Respons selalu generik. */
async function verifyCredentials(accountStore, username, password) {
  if (!accountStore || typeof accountStore.findByUsername !== 'function') return null;
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  if (!USERNAME_RE.test(username.trim())) return null;
  const user = await accountStore.findByUsername(username.trim());
  if (!user || !user.passwordHash) return null;
  // Akun nonaktif diperlakukan sebagai kegagalan login biasa (respons generik).
  if (user.isActive === false) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user : null;
}

function registerAuthRoutes(app, { accountStore, rateLimiter, logger, audit = null }) {
  // Halaman login (tanpa auth). Sesi anonim dibuat agar CSRF token bisa diterbitkan.
  app.get('/web/login', (req, res) => {
    if (req.session && req.session.userId) return res.redirect(302, '/web/dashboard');
    return renderLogin(res, req.session.csrfToken);
  });

  app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body || {};
    const ip = req.ip || 'unknown';
    const limit = rateLimiter.check(ip, typeof username === 'string' ? username : '');
    if (!limit.allowed) {
      logger.warn('Login rate-limited', { ipHash: !!ip });
      return res.status(429).json({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
    }
    let user = null;
    try {
      user = await verifyCredentials(accountStore, username, password);
    } catch (err) {
      logger.error('Login error (internal)', { message: err.message });
      return res.status(500).json({ ok: false, error: 'Terjadi kesalahan internal.' });
    }
    if (!user) {
      rateLimiter.recordFailure(ip, typeof username === 'string' ? username : '');
      if (audit) await audit(req, 'web.auth.login_failed', 'web_user', null, 'respons generik').catch(() => {});
      // Respons generik — tidak membocorkan apakah username ada.
      return res.status(401).json({ ok: false, error: 'Username atau password salah.' });
    }
    rateLimiter.reset(ip, username);
    // Regenerasi session ID setelah login sukses (cegah session fixation),
    // lalu rotate CSRF token milik sesi baru.
    return req.session.regenerate((regenErr) => {
      if (regenErr) {
        logger.error('Session regenerate gagal', { message: regenErr.message });
        return res.status(500).json({ ok: false, error: 'Terjadi kesalahan internal.' });
      }
      req.session.userId = user.id;
      req.session.username = user.username;
      const csrfToken = rotateCsrfToken(req);
      logger.info('Login sukses', { username: user.username });
      if (audit) audit(req, 'web.auth.login', 'web_user', user.id, '').catch(() => {});
      return res.json({ ok: true, user: { username: user.username }, csrfToken });
    });
  });

  app.get('/api/auth/me', requireApiAuth, (req, res) => {
    res.json({
      ok: true,
      user: { username: req.session.username },
      csrfToken: req.session.csrfToken || null,
    });
  });

  app.post('/api/auth/logout', requireApiAuth, (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  // Dashboard (halaman privat).
  app.get('/web/dashboard', (req, res, next) => {
    if (!req.session || !req.session.userId) return res.redirect(302, '/web/login');
    return renderDashboard(res, req.session.csrfToken);
  });

  // Root: arahkan ke dashboard/login.
  app.get('/', (req, res) => {
    if (req.session && req.session.userId) return res.redirect(302, '/web/dashboard');
    return res.redirect(302, '/web/login');
  });

  return app;
}

module.exports = { registerAuthRoutes, verifyCredentials, renderLogin, renderDashboard, USERNAME_RE, BCRYPT_COST };
