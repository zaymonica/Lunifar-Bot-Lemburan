'use strict';

/**
 * Konfigurasi Web Admin (Tahap 1).
 * Tidak membaca .env di sini — env diteruskan dari pemanggil agar mudah diuji.
 * Secret tidak boleh punya nilai default di source code.
 */

function randomHint() {
  return 'openssl rand -hex 32';
}

function createWebConfig(env = process.env) {
  const sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret || typeof sessionSecret !== 'string' || sessionSecret.trim().length < 32) {
    const err = new Error(
      'SESSION_SECRET wajib diisi minimal 32 karakter untuk Web Admin. ' +
      `Generate dengan: ${randomHint()}`
    );
    err.code = 'WEB_ENV_VALIDATION';
    throw err;
  }
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  // Base URI Passenger (mis. /overtime-bot). Kosong = tanpa prefix.
  // Hanya diizinkan berupa satu segmen-path awal dengan slash pembuka.
  let basePath = typeof env.WEB_BASE_PATH === 'string' ? env.WEB_BASE_PATH.trim() : '';
  if (basePath && !/^\/[A-Za-z0-9._-]+$/.test(basePath)) {
    const err = new Error(`WEB_BASE_PATH tidak valid: "${basePath}". Gunakan format "/nama-aplikasi".`);
    err.code = 'WEB_ENV_VALIDATION';
    throw err;
  }
  const ttlHours = Number(env.WEB_SESSION_TTL_HOURS || 8);
  return {
    sessionSecret: sessionSecret.trim(),
    nodeEnv,
    isProduction,
    // Cookie Secure hanya saat production (dianggap berjalan di belakang HTTPS cPanel).
    secureCookies: isProduction,
    // Di production TLS di-terminate reverse proxy (Passenger/cPanel) —
    // trust proxy diperlukan agar req.secure/req.ip benar. Bisa dipaksa via TRUST_PROXY.
    trustProxy: env.TRUST_PROXY ? env.TRUST_PROXY === '1' : isProduction,
    sessionTtlMs: (Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : 8) * 3600 * 1000,
    basePath,
  };
}

module.exports = { createWebConfig };
