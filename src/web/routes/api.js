'use strict';

/**
 * API Web Admin (Tahap 3). Semua endpoint di belakang requireApiAuth;
 * semua mutasi di belakang CSRF middleware global (index.js).
 * Response konsisten: { ok: true, data } — error domain dipetakan ke HTTP.
 * Bisnis logic TIDAK digandakan: approval lewat ApprovalService, laporan lewat
 * ReportService + payroll.aggregateMonthly, data lewat repo existing.
 */

const fs = require('fs');
const { Telegraf } = require('telegraf');
const { ValidationError, AuthError, NotFoundError, ConflictError } = require('../../utils/errors');
const { aggregateMonthly } = require('../../services/payroll');
const { startOfDayInTz } = require('../../utils/date-time');
const { buildPayrollWorkbook, exportFileName } = require('../../services/payroll-excel');

const HTTP_STATUS = {
  [ValidationError.name]: 400,
  [AuthError.name]: 403,
  [NotFoundError.name]: 404,
  [ConflictError.name]: 409,
};

/** Wrapper handler async + pemetaan error domain → HTTP. */
function h(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      let status = HTTP_STATUS[err && err.constructor && err.constructor.name] || 0;
      // Error konfigurasi env (mis. WEB_SETTINGS_KEY belum diset) → 400 dengan
      // pesan jelas (pesan hanya menyebut nama variabel env, tanpa secret).
      if (!status && err && err.code === 'WEB_ENV_VALIDATION') status = 400;
      if (status === 500 || !status) return next(err);
      return res.status(status).json({ ok: false, error: err.message });
    });
  };
}

function intParam(v, { min = 1, max = 200, def = null } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError('Parameter angka tidak valid.');
  return n;
}

function dateParam(v, field) {
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new ValidationError(`${field} harus format YYYY-MM-DD.`);
  return String(v);
}

const OVERTIME_STATUSES = ['active', 'pending', 'approved', 'rejected', 'completed'];
const EMPLOYEE_STATUSES = ['active', 'pending', 'rejected', 'inactive'];
const ROLES = ['employee', 'supervisor', 'admin'];
const LANGS = ['id', 'en', 'vi', 'zh-TW'];
const TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;

function registerApiRoutes(app, deps) {
  const {
    config, employeeRepo, overtimeRepo, approvalService, reportService,
    settingsStore, adminAudit, botLifecycle, logger,
  } = deps;
  const audit = adminAudit.logger;
  const envAdminIds = config.adminTelegramIds || [];

  app.get('/api/dashboard', h(async (req, res) => {
    const [empStatus, otStatus, pending] = await Promise.all([
      employeeRepo.countByStatus(),
      overtimeRepo.countByStatus(),
      approvalService.listPending(50),
    ]);
    const byStatus = Object.fromEntries(empStatus.map((r) => [r.status, r.cnt]));
    const otByStatus = Object.fromEntries(otStatus.map((r) => [r.status, r.cnt]));
    return res.json({
      ok: true,
      data: {
        employees: {
          total: empStatus.reduce((s, r) => s + r.cnt, 0),
          active: byStatus.active || 0,
          pending: byStatus.pending || 0,
          rejected: byStatus.rejected || 0,
          inactive: byStatus.inactive || 0,
        },
        overtime: otByStatus,
        pendingApprovals: pending.length,
        bot: botLifecycle ? botLifecycle.status : { state: 'unavailable' },
      },
    });
  }));

  // ---- Pegawai ----
  app.get('/api/employees', h(async (req, res) => {
    const search = req.query.search ? String(req.query.search).trim().slice(0, 80) : null;
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !EMPLOYEE_STATUSES.includes(status)) throw new ValidationError('Status tidak valid.');
    const rows = await employeeRepo.list({
      search,
      status,
      limit: intParam(req.query.limit, { min: 1, max: 200, def: 50 }),
      offset: intParam(req.query.offset, { min: 0, max: 100000, def: 0 }),
    });
    return res.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id, fullName: r.full_name, employeeNumber: r.employee_number,
        department: r.department, role: r.role, status: r.status,
        isActive: !!r.is_active, language: r.language || 'id',
      })),
    });
  }));

  app.post('/api/employees/:id/status', h(async (req, res) => {
    const id = intParam(req.params.id, { min: 1, max: 2 ** 53 });
    const status = String((req.body && req.body.status) || '');
    if (!EMPLOYEE_STATUSES.includes(status)) throw new ValidationError('Status tidak valid (active|rejected|inactive).');
    const emp = await employeeRepo.findById(id);
    if (!emp) throw new NotFoundError('Pegawai tidak ditemukan.');
    const ok = await employeeRepo.setStatus(id, status, status === 'active');
    if (!ok) throw new ConflictError('Perubahan status gagal.');
    await audit(req, `web.employee.${status === 'active' ? 'approve' : status}`, 'employee', id, status);
    return res.json({ ok: true, data: { id, status } });
  }));

  app.post('/api/employees/:id/role', h(async (req, res) => {
    const id = intParam(req.params.id, { min: 1, max: 2 ** 53 });
    const role = String((req.body && req.body.role) || '');
    if (!ROLES.includes(role)) throw new ValidationError('Role tidak valid.');
    const emp = await employeeRepo.findById(id);
    if (!emp) throw new NotFoundError('Pegawai tidak ditemukan.');
    await employeeRepo.setRole(id, role);
    await audit(req, 'web.employee.role', 'employee', id, role);
    return res.json({ ok: true, data: { id, role } });
  }));

  app.post('/api/employees/:id/language', h(async (req, res) => {
    const id = intParam(req.params.id, { min: 1, max: 2 ** 53 });
    const language = String((req.body && req.body.language) || '');
    if (!LANGS.includes(language)) throw new ValidationError('Bahasa tidak valid (id|en).');
    const emp = await employeeRepo.findById(id);
    if (!emp) throw new NotFoundError('Pegawai tidak ditemukan.');
    await employeeRepo.setLanguage(id, language);
    await audit(req, 'web.employee.language', 'employee', id, language);
    return res.json({ ok: true, data: { id, language } });
  }));

  registerOvertimeRoutes(app, { config, overtimeRepo, employeeRepo, approvalService, audit, envAdminIds });
  registerReportRoutes(app, { config, reportService, overtimeRepo });
  registerSettingRoutes(app, { config, settingsStore, audit, botLifecycle, logger });
  registerAuditRoute(app, { adminAudit });
}

// ---- Lembur & persetujuan ----
function registerOvertimeRoutes(app, { config, overtimeRepo, employeeRepo, approvalService, audit, envAdminIds }) {
  app.get('/api/overtime', h(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !OVERTIME_STATUSES.includes(status)) throw new ValidationError('Status tidak valid.');
    const from = dateParam(req.query.from, 'from');
    const to = dateParam(req.query.to, 'to');
    const rows = await overtimeRepo.search({
      employeeId: intParam(req.query.employeeId, { min: 1, max: 2 ** 53, def: null }),
      department: req.query.department ? String(req.query.department).trim().slice(0, 80) : null,
      status,
      fromUtc: from ? startOfDayInTz(`${from}T00:00:00Z`, config.timezone) : null,
      toUtc: to ? new Date(startOfDayInTz(`${to}T00:00:00Z`, config.timezone).getTime() + 86400000) : null,
      limit: intParam(req.query.limit, { min: 1, max: 500, def: 50 }),
      offset: intParam(req.query.offset, { min: 0, max: 100000, def: 0 }),
    });
    return res.json({ ok: true, data: rows });
  }));

  app.get('/api/overtime/:id', h(async (req, res) => {
    const id = intParam(req.params.id, { min: 1, max: 2 ** 53 });
    const row = await overtimeRepo.findById(id);
    if (!row) throw new NotFoundError('Sesi lembur tidak ditemukan.');
    return res.json({ ok: true, data: row });
  }));

  app.get('/api/approvals/pending', h(async (req, res) => {
    const rows = await approvalService.listPending(50);
    return res.json({ ok: true, data: rows });
  }));

  app.post('/api/approvals/:sessionId/decide', h(async (req, res) => {
    const sessionId = intParam(req.params.sessionId, { min: 1, max: 2 ** 53 });
    const approve = !!(req.body && req.body.approve);
    const note = req.body && req.body.note ? String(req.body.note).slice(0, 500) : null;
    // Web admin bertindak lewat pegawai penyetuju yang dipetakan via env
    // WEB_APPROVER_EMPLOYEE_ID (harus role admin/supervisor aktif di employees).
    // Guard self-approval & aturan bisnis tetap dijalankan ApprovalService.
    const approverEmpId = intParam(process.env.WEB_APPROVER_EMPLOYEE_ID, { min: 1, max: 2 ** 53, def: null });
    if (!approverEmpId) {
      throw new ConflictError('Persetujuan web belum dikonfigurasi: set WEB_APPROVER_EMPLOYEE_ID (id pegawai admin/supervisor aktif).');
    }
    const approver = await employeeRepo.findById(approverEmpId);
    if (!approver) throw new ConflictError('WEB_APPROVER_EMPLOYEE_ID tidak merujuk pegawai yang ada.');
    const result = await approvalService.decide({ approver, sessionId, approve, note, envAdminIds });
    await audit(req, approve ? 'web.overtime.approve' : 'web.overtime.reject', 'overtime_session', sessionId, note || '');
    return res.json({
      ok: true,
      data: {
        sessionId,
        status: result.status,
        actualMinutes: result.actualMinutes,
        payableMinutes: result.payableMinutes,
      },
    });
  }));
}

// ---- Laporan ----
function registerReportRoutes(app, { config, reportService, overtimeRepo }) {
  app.get('/api/reports/recap', h(async (req, res) => {
    const filters = await reportService.buildFilters({
      from: dateParam(req.query.from, 'from'),
      to: dateParam(req.query.to, 'to'),
      department: req.query.department,
      status: req.query.status,
      employeeNumber: req.query.employeeNumber,
    });
    const recap = await reportService.recap(filters);
    return res.json({ ok: true, data: recap });
  }));

  app.get('/api/reports/export', h(async (req, res) => {
    const filters = await reportService.buildFilters({
      from: dateParam(req.query.from, 'from'),
      to: dateParam(req.query.to, 'to'),
      department: req.query.department,
      status: req.query.status,
      employeeNumber: req.query.employeeNumber,
    });
    const filePath = await reportService.exportExcel(filters, req.session.username || 'web-admin');
    try {
      res.download(filePath, `laporan-lembur-${Date.now()}.xlsx`);
    } finally {
      // Kontrak report.service: pemanggil wajib menghapus file sementara.
      res.on('finish', () => fs.unlink(filePath, () => {}));
    }
  }));

  const monthWindow = (year, month) => {
    const tz = config.timezone;
    const startUtc = startOfDayInTz(`${year}-${String(month).padStart(2, '0')}-01T00:00:00Z`, tz);
    const nm = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
    const endUtc = startOfDayInTz(`${nm.y}-${String(nm.m).padStart(2, '0')}-01T00:00:00Z`, tz);
    return { startUtc, endUtc, tz };
  };

  app.get('/api/reports/payroll', h(async (req, res) => {
    const month = intParam(req.query.month, { min: 1, max: 12 });
    const year = intParam(req.query.year, { min: 2000, max: 2100 });
    const { startUtc, endUtc, tz } = monthWindow(year, month);
    const rows = await overtimeRepo.search({ fromUtc: startUtc, toUtc: endUtc, limit: 2000 });
    const agg = aggregateMonthly(rows, tz);
    return res.json({
      ok: true,
      data: {
        year, month,
        totals: agg.totals,
        days: agg.days.map((d) => ({ key: d.key, totalMinutes: d.totalMinutes, totalCents: d.totalCents })),
      },
    });
  }));

  app.get('/api/reports/payroll-export', h(async (req, res) => {
    const month = intParam(req.query.month, { min: 1, max: 12 });
    const year = intParam(req.query.year, { min: 2000, max: 2100 });
    const { startUtc, endUtc, tz } = monthWindow(year, month);
    const rows = await overtimeRepo.search({ fromUtc: startUtc, toUtc: endUtc, limit: 2000 });
    const agg = aggregateMonthly(rows, tz);
    const buffer = await buildPayrollWorkbook({ aggregate: agg, rows, year, month, timezone: tz });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(year, month)}"`);
    return res.send(buffer);
  }));
}

// ---- Pengaturan & kontrol bot ----
function registerSettingRoutes(app, { config, settingsStore, audit, botLifecycle, logger }) {
  app.get('/api/settings', h(async (req, res) => {
    const tokenStatus = await settingsStore.getBotTokenStatus();
    return res.json({
      ok: true,
      data: {
        botToken: tokenStatus, // { enabled, configured, masked } — plaintext tidak pernah keluar
        timezone: config.timezone,
        overtime: config.overtime,
        // Perubahan setting ini tetap via .env (didokumentasikan); hanya token bot yang diubah lewat web.
        editableEnv: ['APP_TIMEZONE', 'OVERTIME_MIN_MINUTES', 'OVERTIME_ROUNDING_MINUTES', 'OVERTIME_MAX_HOURS_PER_DAY'],
      },
    });
  }));

  app.post('/api/settings/bot-token', h(async (req, res) => {
    const token = String((req.body && req.body.token) || '').trim();
    const test = !!(req.body && req.body.test);
    if (!TOKEN_RE.test(token)) throw new ValidationError('Format token tidak valid (harus token bot Telegram).');
    await settingsStore.setBotToken(token);
    await audit(req, 'web.settings.bot_token.save', 'settings', 'bot_token', test ? 'dengan uji koneksi' : 'tanpa uji koneksi');
    const out = { ok: true, data: { saved: true, tested: false } };
    if (!test) return res.json(out);
    // Uji koneksi HANYA karena admin eksplisit memilih "test". getMe tidak
    // memulai polling dan tidak mengubah webhook. Token tidak pernah dikirim balik.
    try {
      const tg = new Telegraf(token);
      const me = await tg.telegram.getMe();
      await tg.telegram.close().catch(() => {});
      out.data.tested = true;
      out.data.botUsername = me.username; // nama publik bot, bukan rahasia
      await audit(req, 'web.settings.bot_token.test', 'settings', 'bot_token', `ok:@${me.username}`);
    } catch (err) {
      if (logger && logger.warn) logger.warn('Uji koneksi token gagal', { code: err.code });
      out.data.tested = false;
      out.data.testError = 'Token tidak dapat menghubungi Telegram (periksa token/koneksi).';
    }
    return res.json(out);
  }));

  app.delete('/api/settings/bot-token', h(async (req, res) => {
    if (!settingsStore.tokenEnabled) {
      throw new ValidationError('Penyimpanan token via web nonaktif (WEB_SETTINGS_KEY belum di-set).');
    }
    await settingsStore.clearBotToken();
    await audit(req, 'web.settings.bot_token.clear', 'settings', 'bot_token', '');
    return res.json({ ok: true, data: { cleared: true } });
  }));

  app.get('/api/bot', h(async (req, res) => {
    const tokenStatus = await settingsStore.getBotTokenStatus();
    const status = botLifecycle.status;
    status.tokenConfigured = tokenStatus.configured || !!config.botToken;
    return res.json({ ok: true, data: status });
  }));

  const botAction = (action) => h(async (req, res) => {
    if (!botLifecycle) throw new ConflictError('Lifecycle bot tidak tersedia.');
    let result;
    try {
      result = await botLifecycle[action]();
    } catch (err) {
      // BotLifecycle melempar Error umum untuk transisi ilegal (mis. start saat running) → 409.
      throw new ConflictError(err.message || 'Transisi status bot tidak valid.');
    }
    await audit(req, `web.bot.${action}`, 'bot', 'lifecycle', `state=${result.state}`);
    return res.json({ ok: true, data: result });
  });
  app.post('/api/bot/start', botAction('start'));
  app.post('/api/bot/stop', botAction('stop'));
  app.post('/api/bot/restart', botAction('restart'));
}

// ---- Audit ----
function registerAuditRoute(app, { adminAudit }) {
  app.get('/api/audit', h(async (req, res) => {
    const rows = await adminAudit.repo.list({
      limit: intParam(req.query.limit, { min: 1, max: 200, def: 50 }),
      offset: intParam(req.query.offset, { min: 0, max: 100000, def: 0 }),
      action: req.query.action ? String(req.query.action).slice(0, 64) : null,
    });
    return res.json({ ok: true, data: rows });
  }));
}

module.exports = { registerApiRoutes };


