'use strict';

/**
 * Entry point Web Admin + Bot (Tahap 3).
 *
 * - Menjalankan server web (login, dashboard, API) di WEB_PORT.
 * - Bot TIDAK di-start otomatis: admin memulai dari UI (BotLifecycle.start()).
 *   Untuk mode bot-only tanpa web, gunakan src/app.js seperti sebelumnya.
 * - Semua secret dari env; tanpa nilai default di source code.
 */

const { loadEnv } = require('../config/env');
const { createPool } = require('../config/database');
const { createLogger } = require('../utils/logger');
const { EmployeeRepo } = require('../repositories/employee.repo');
const { OvertimeRepo, ApprovalRepo, AuditRepo, SettingsRepo } = require('../repositories/overtime.repo');
const { EmployeeService } = require('../services/employee.service');
const { OvertimeService } = require('../services/overtime.service');
const { ApprovalService } = require('../services/approval.service');
const { ReportService } = require('../services/report.service');
const { NotificationService } = require('../services/notification.service');
const { createWebApp } = require('./index');
const { WebUserRepository, createDbAccountStore } = require('./web-user.repo');
const { WebSettingsStore } = require('./settings-store');
const { AdminAuditRepo, makeAuditLogger } = require('./admin-audit');
const { BotLifecycle } = require('./bot-lifecycle');

async function main() {
  let config;
  try {
    // Web Admin: BOT_TOKEN opsional (diisi via UI Pengaturan; bot tidak pernah
    // di-start otomatis). Mode bot-only (src/app.js) tetap mewajibkannya.
    config = loadEnv({ requireBotToken: false });
  } catch (err) {
    console.error(`[STARTUP GAGAL] ${err.message}`);
    process.exit(1);
  }
  const logger = createLogger(config.logLevel);
  if (!config.botToken) {
    logger.info('BOT_TOKEN tidak diisi — bot dapat di-start nanti dari UI Pengaturan Web Admin.');
  }
  logger.info('Memulai Lunifar Web Admin', { nodeEnv: config.nodeEnv, timezone: config.timezone });

  const pool = createPool(config.db);
  try {
    await pool.query('SELECT 1');
    logger.info('Koneksi database OK');
  } catch (err) {
    logger.error('Koneksi database gagal.', { code: err.code });
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

  // Store web: akun DB, settings terenkripsi, audit.
  const webUsers = new WebUserRepository(pool);
  const accountStore = createDbAccountStore(webUsers);
  // Resolusi kunci pengaturan: tidak di-set → peringatan jelas (fitur nonaktif,
  // server tetap berjalan); di-set tapi lemah → gagal cepat dengan pesan jelas.
  let settingsKeyResult;
  try {
    settingsKeyResult = WebSettingsStore.resolveSettingsKey(process.env.WEB_SETTINGS_KEY);
  } catch (err) {
    logger.error(`[STARTUP GAGAL] ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  if (settingsKeyResult.warning) logger.warn(settingsKeyResult.warning);
  const settingsStore = new WebSettingsStore({
    settingsRepo,
    settingsKey: settingsKeyResult.key, // null = fitur token via web nonaktif (fail-closed)
  });
  const adminAuditRepo = new AdminAuditRepo(pool);
  const adminAudit = { repo: adminAuditRepo, logger: makeAuditLogger(adminAuditRepo) };

  const botLifecycle = new BotLifecycle({ config, services, settingsStore, logger });

  const app = createWebApp({
    accountStore,
    env: process.env,
    logger,
    apiDeps: {
      config,
      employeeRepo,
      overtimeRepo,
      approvalService: services.approvalService,
      reportService: services.reportService,
      settingsStore,
      adminAudit,
      botLifecycle,
      logger,
    },
  });

  // Bind eksplisit ke loopback (lokal saja) kecuali WEB_HOST diisi eksplisit —
  // produksi cPanel/Passenger mengelola binding-nya sendiri via env.
  const port = Number(process.env.WEB_PORT || 3001);
  const host = process.env.WEB_HOST || '127.0.0.1';
  const server = app.listen(port, host, () => {
    logger.info(`Web Admin berjalan di http://${host}:${port} — Bot menunggu perintah start dari UI.`);
  });

  const shutdown = async (sig) => {
    logger.info(`Menerima ${sig}, mematikan...`);
    server.close(() => process.exit(0));
    if (botLifecycle.state === 'running') {
      await botLifecycle.stop().catch(() => {});
    }
    await pool.end().catch(() => {});
    setTimeout(() => process.exit(0), 3000).unref();
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
