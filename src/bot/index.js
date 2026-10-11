'use strict';
const { Telegraf } = require('telegraf');
const { makeAuthMiddleware, makeCallbackGuard } = require('./middleware/auth');
const { registerCommonHandlers } = require('./handlers/common');
const { registerOvertimeHandlers } = require('./handlers/overtime');
const { mainMenu } = require('./keyboards');

function createBot({ config, services, logger }) {
  const bot = new Telegraf(config.botToken, { handlerTimeout: 90000 });
  bot.use(makeCallbackGuard());
  bot.use(makeAuthMiddleware({ employeeService: services.employeeService, config }));

  // Menu utama dikirim oleh handler /start di common.js; tidak ada alur admin.

  registerCommonHandlers(bot, services);
  registerOvertimeHandlers(bot, services);

  bot.catch((err, ctx) => {
    logger.error('Unhandled bot error', { updateType: ctx.updateType, error: err.message });
    if (ctx.callbackQuery) ctx.answerCbQuery('Terjadi kesalahan.').catch(() => {});
    else if (ctx.reply) ctx.reply('Terjadi kesalahan internal. Silakan coba lagi.').catch(() => {});
  });

  return bot;
}

module.exports = { createBot };
