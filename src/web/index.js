'use strict';

const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { createWebConfig } = require('./config');
const { makeLoginRateLimiter } = require('./rate-limit');
const { requireApiAuth } = require('./middleware/auth');
const { attachCsrfToken, requireCsrfToken } = require('./middleware/csrf');
const { registerAuthRoutes } = require('./routes/auth');
const { registerApiRoutes } = require('./routes/api');

/**
 * Factory Web Admin (Tahap 1).
 *
 * - TIDAK membuka port dan TIDAK menjalankan bot — pemanggil yang memutuskan
 *   kapan app di-listen (integrasi startup menyusul tahap berikutnya).
 * - accountStore wajib disediakan pemanggil (in-memory untuk test; store DB
 *   menyusul bersama migration web_users).
 */

const DEFAULT_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createWebApp({
  accountStore,
  config = null,
  env = null,
  logger = DEFAULT_LOGGER,
  sessionSecret = null, // pintasan untuk test; produksi memakai config/env
  apiDeps = null, // Tahap 3: deps registerApiRoutes; null = API domain dimatikan (mode test Tahap 1/2)
} = {}) {
  if (!accountStore) throw new Error('createWebApp: accountStore wajib disediakan.');
  // sessionSecret eksplisit (dipakai test/embedding) menghindari validasi env.
  const cfg = config || (sessionSecret ? createWebConfig({ ...env, SESSION_SECRET: sessionSecret }) : createWebConfig(env || process.env));
  const secret = sessionSecret || cfg.sessionSecret;
  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);

  // Kompatibilitas cPanel/Passenger Base URI (mis. /overtime-bot): jika prefix
  // masih menempel di path yang diterima Express, hapus SEKALI di awal path
  // sebelum route/asset didaftarkan. Query string dan path lain tidak diubah.
  // Aman terhadap double-strip: hanya menghapus prefix tepat di awal, dan
  // idempoten karena hasil strip tidak lagi diawali prefix.
  if (cfg.basePath) {
    const prefix = cfg.basePath.replace(/\/+$/, ''); // normalisasi tanpa trailing slash
    app.use((req, res, next) => {
      const original = req.originalUrl !== undefined ? req.originalUrl : req.url;
      if (req.originalUrl === undefined) req.originalUrl = original;
      // Idempoten: hasil strip tidak lagi diawali prefix, jadi aman bila
      // Passenger juga sudah menghapus prefix sebelumnya (tidak dobel-strip).
      if (original === prefix) {
        req.url = '/';
      } else if (original.startsWith(`${prefix}/`)) {
        req.url = original.slice(prefix.length);
      }
      return next();
    });
  }

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // HSTS hanya bermakna di belakang HTTPS (production cPanel).
    strictTransportSecurity: cfg.isProduction ? { maxAge: 15552000 } : false,
  }));

  app.use(session({
    name: 'lunifar.sid',
    secret,
    resave: false,
    saveUninitialized: true, // dibutuhkan untuk menerbitkan CSRF token pra-login
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: cfg.secureCookies,
      maxAge: cfg.sessionTtlMs,
      path: '/',
    },
  }));

  // Batas ukuran body (DoS kecil-scale) + JSON saja.
  app.use(express.json({ limit: '16kb' }));

  // CSRF terbit + guard state-changing.
  app.use(attachCsrfToken);
  app.use(requireCsrfToken);

  // Aset statis (css/js) — tidak memuat data apa pun.
  app.use('/admin', express.static(path.join(__dirname, '..', '..', 'public', 'admin'), {
    index: false,
    maxAge: '1h',
  }));

  registerAuthRoutes(app, {
    accountStore,
    rateLimiter: makeLoginRateLimiter(),
    logger,
    audit: apiDeps && apiDeps.adminAudit ? apiDeps.adminAudit.logger : null,
  });

  // API domain (Tahap 3) — semua di belakang requireApiAuth. CSRF sudah
  // diguard global di atas; route /api/auth/* terdaftar lebih dulu sehingga
  // tetap bisa diakses tanpa sesi (login) karena dieksekusi sebelum guard ini.
  if (apiDeps) {
    app.use('/api', requireApiAuth);
    registerApiRoutes(app, apiDeps);
  }

  // 404 JSON untuk path API, halaman sederhana untuk lainnya.
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan.' });
    }
    return res.status(404).type('html').send('<h1>404</h1><p>Halaman tidak ditemukan.</p>');
  });

  // Error handler: tidak membocorkan stack ke client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('Web error', { message: err && err.message });
    if (err && (err.type === 'entity.too.large' || err.status === 400)) {
      return res.status(400).json({ ok: false, error: 'Request tidak valid.' });
    }
    return res.status(500).json({ ok: false, error: 'Terjadi kesalahan internal.' });
  });

  return app;
}

module.exports = { createWebApp, requireApiAuth };
