'use strict';
const { AuthError } = require('../../utils/errors');

/** Middleware otentikasi & role. Attaches ctx.state.employee bila terdaftar. */
function makeAuthMiddleware({ employeeService, config }) {
  return async (ctx, next) => {
    const tgId = ctx.from && ctx.from.id;
    if (!tgId) return; // bukan dari user (mis. channel post)
    ctx.state.telegramUserId = tgId;
    ctx.state.isAdmin = await employeeService.isAdmin(tgId, config.adminTelegramIds);
    try {
      ctx.state.employee = await employeeService.getOrCreate(tgId);
    } catch (e) {
      ctx.state.employee = null;
    }
    return next();
  };
}

function requireAdmin(ctx) {
  if (!ctx.state.isAdmin) throw new AuthError('Perintah ini hanya untuk admin.');
}

function requireActive(ctx) {
  if (!ctx.state.employee || ctx.state.employee.status !== 'active' || !ctx.state.employee.is_active) {
    throw new AuthError('Akun Anda belum aktif. Gunakan /start untuk mendaftar atau hubungi admin.');
  }
  return ctx.state.employee;
}

/** Idempotensi callback: cegah pemrosesan berulang (double-click / replay) dalam jendela waktu. */
function makeCallbackGuard({ maxKeys = 5000 } = {}) {
  const seen = new Map(); // key -> expiry
  setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  }, 60 * 1000).unref();

  return async (ctx, next) => {
    if (!ctx.callbackQuery) return next();
    const key = `${ctx.callbackQuery.id}`;
    const now = Date.now();
    if (seen.has(key)) {
      await ctx.answerCbQuery('Sudah diproses.').catch(() => {});
      return undefined;
    }
    seen.set(key, now + 10 * 60 * 1000); // TTL 10 menit
    return next();
  };
}

module.exports = { makeAuthMiddleware, requireAdmin, requireActive, makeCallbackGuard };
