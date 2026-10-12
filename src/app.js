'use strict';
const { loadEnv } = require('./config/env');
const { createPool } = require('./config/database');
const { createLogger } = require('./utils/logger');
const { EmployeeRepo } = require('./repositories/employee.repo');
const { OvertimeRepo, ApprovalRepo, AuditRepo, SettingsRepo } = require('./repositories/overtime.repo');
const { EmployeeService } = require('./services/employee.service');
const { OvertimeService } = require('./services/overtime.service');
const { ApprovalService } = require('./services/approval.service');
const { ReportService } = require('./services/report.service');
const { NotificationService } = require('./services/notification.service');
const { createBot } = require('./bot');

async function main() {
  let config;
  try {
    config = loadEnv();
  } catch (err) {
    console.error(`[STARTUP GAGAL] ${err.message}`);
    process.exit(1);
  }
  const logger = createLogger(config.logLevel);
  logger.info('Memulai Lunifar Overtime Bot', { nodeEnv: config.nodeEnv, timezone: config.timezone });

  const pool = createPool(config.db);
  try {
    await pool.query('SELECT 1');
    logger.info('Koneksi database OK');
  } catch (err) {
    logger.error('Koneksi database gagal. Periksa DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.', { code: err.code });
    await pool.end().catch(() => {});
    process.exit(1);
  }

  const employeeRepo = new EmployeeRepo(pool);
  const overtimeRepo = new OvertimeRepo(pool);
  const approvalRepo = new ApprovalRepo(pool);
  const auditRepo = new AuditRepo(pool);
  const settingsRepo = new SettingsRepo(pool);

  const notificationService = new NotificationService({ bot: null, employeeRepo, logger });
  notificationService.setAdminIds(config.adminTelegramIds);

  const services = {
    config,
    employeeService: new EmployeeService({ employeeRepo, auditRepo, notificationService }),
    overtimeService: new OvertimeService({ overtimeRepo, auditRepo, notificationService, config }),
    approvalService: new ApprovalService({ overtimeRepo, approvalRepo, auditRepo, notificationService, config }),
    reportService: new ReportService({ overtimeRepo, employeeRepo, config, logger }),
    notificationService,
    overtimeRepo,
    logger,
  };

  const bot = createBot({ config, services, logger });
  notificationService.bot = bot;

  // Polling (default). HANYA satu instance boleh aktif untuk satu token
  // — dua polling bersamaan akan menyebabkan konflik getUpdates (409).
  await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch((e) =>
    logger.warn('Gagal menghapus webhook', { error: e.message }));
  await bot.launch(() => {});
  logger.info('Bot berjalan (long polling). Tekan Ctrl+C untuk berhenti.');

  const shutdown = async (sig) => {
    logger.info(`Menerima ${sig}, mematikan...`);
    bot.stop(sig);
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[FATAL]', err.message);
    process.exit(1);
  });
}

module.exports = { main };
