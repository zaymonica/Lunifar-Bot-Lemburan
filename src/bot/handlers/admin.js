'use strict';
const fs = require('fs');
const { REGEX_CB } = require('../keyboards');
const i18n = require('../../i18n');

function registerAdminHandlers(bot, services) {
  const { employeeService, approvalService, reportService, overtimeRepo, config, notificationService } = services;
  const isAdmin = (ctx) => ctx.state.isAdmin === true;
  const L = (ctx) => i18n.normalizeLang(ctx.state && ctx.state.employee && ctx.state.employee.language);
  const T = (ctx) => (key, params) => i18n.t(L(ctx), key, params);
  const E = (ctx, msg) => i18n.trError(L(ctx), msg);

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T(ctx)('admin.only'));
    const [stats, pendingOv, statsOv] = await Promise.all([
      employeeService.employeeRepo.countByStatus(),
      approvalService.listPending(10),
      overtimeRepo.statsToday(),
    ]);
    const byStatus = Object.fromEntries(stats.map((s) => [s.status, s.cnt]));
    const tr = T(ctx);
    let msg = `${tr('admin.title')}\n\n`
      + `${tr('admin.employeesLine', {
        active: byStatus.active || 0, pending: byStatus.pending || 0,
        rejected: byStatus.rejected || 0, inactive: byStatus.inactive || 0,
      })}\n`
      + `${tr('admin.overtimeLine', { active: statsOv.active_count || 0, pending: statsOv.pending_count || 0 })}\n\n`;
    if (pendingOv.length) {
      msg += `${tr('admin.pendingTitle')}\n`;
      for (const s of pendingOv) msg += `• #${s.id} ${s.full_name} (${s.department})\n`;
    } else {
      msg += `${tr('admin.noPending')}\n`;
    }
    msg += `\n${tr('admin.commandsTitle')}\n`
      + `${tr('admin.cmdKaryawan')}\n`
      + `${tr('admin.cmdPending')}\n`
      + `${tr('admin.cmdExport')}\n`
      + `${tr('admin.cmdRekap')}`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  const panelButtonLabels = [i18n.CATALOGS.id.keys['admin.panelButton']];
  for (const l of ['en', 'zh-TW', 'vi']) panelButtonLabels.push(i18n.CATALOGS[l].keys['admin.panelButton']);
  const escaped = panelButtonLabels.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  bot.hears(new RegExp(`^(?:${escaped.join('|')})$`), (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T(ctx)('admin.only'));
    ctx.reply(T(ctx)('admin.usePanel'));
  });

  bot.command('karyawan', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T(ctx)('admin.only'));
    const lang = L(ctx);
    const tr = T(ctx);
    const search = (ctx.message.text || '').replace(/^\/karyawan\s*/i, '').trim() || null;
    const rows = await employeeService.employeeRepo.list({ search, limit: 15 });
    if (!rows.length) return ctx.reply(tr('admin.noEmployees'));
    for (const e of rows) {
      const btn = [];
      if (e.status === 'pending') {
        btn.push([{ text: tr('admin.approveBtn'), callback_data: `reg:ok:${e.id}` }, { text: tr('admin.rejectBtn'), callback_data: `reg:no:${e.id}` }]);
      } else if (e.status === 'active') {
        btn.push([{ text: tr('admin.deactivateBtn'), callback_data: `emp:off:${e.id}` }]);
      } else if (e.status === 'inactive') {
        btn.push([{ text: tr('admin.activateBtn'), callback_data: `emp:on:${e.id}` }]);
      }
      await ctx.reply(
        tr('admin.employeeLine', {
          id: e.id, name: e.full_name, empnum: e.employee_number || '-',
          dept: e.department, status: e.status, tgid: e.telegram_user_id,
        }),
        { reply_markup: btn.length ? { inline_keyboard: btn } : undefined }
      );
    }
  });

  bot.command('pending', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T(ctx)('admin.only'));
    const tr = T(ctx);
    const rows = await approvalService.listPending(15);
    if (!rows.length) return ctx.reply(tr('admin.noPending'));
    for (const s of rows) {
      await ctx.reply(
        tr('admin.pendingLine', {
          id: s.id, name: s.full_name, dept: s.department,
          start: String(s.start_at).replace('T', ' '),
          end: String(s.end_at).replace('T', ' '),
          note: s.note || '-',
        }),
        { reply_markup: { inline_keyboard: [[
          { text: tr('admin.approveBtn'), callback_data: `ov:ok:${s.id}` },
          { text: tr('admin.rejectBtn'), callback_data: `ov:no:${s.id}` },
        ]] } }
      );
    }
  });

  registerAdminCallbacks(bot, services);
  registerAdminReports(bot, services);
}

// ---- Callbacks persetujuan (dengan idempotensi via callbackQuery.id di middleware) ----
function registerAdminCallbacks(bot, services) {
  const { employeeService, approvalService, notificationService, config } = services;
  const isAdmin = (ctx) => ctx.state.isAdmin === true;
  const L = (ctx) => i18n.normalizeLang(ctx.state && ctx.state.employee && ctx.state.employee.language);
  const T = (ctx) => (key, params) => i18n.t(L(ctx), key, params);
  const E = (ctx, msg) => i18n.trError(L(ctx), msg);

  bot.action(/^reg:(ok|no):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery(T(ctx)('admin.notAuthorized'));
    const tr = T(ctx);
    const approve = ctx.match[1] === 'ok';
    const id = ctx.match[2];
    try {
      const t = await employeeService.decideRegistration(ctx.from.id, id, approve);
      await ctx.answerCbQuery(approve ? tr('admin.approvedToast') : tr('admin.rejectedToast'));
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      ctx.reply(tr('admin.regDecided', {
        icon: approve ? '✅' : '❌',
        id,
        name: t.full_name,
        verdict: tr(approve ? 'admin.verdictApproved' : 'admin.verdictRejected'),
      }));
      // Notifikasi ke karyawan dalam bahasa penerima; fallback sendTo untuk test double.
      const notify = notificationService.sendToLocalized
        ? notificationService.sendToLocalized.bind(notificationService)
        : (empId, build) => notificationService.sendTo(empId, build(i18n.t.bind(null, 'id')));
      notify(id, (t) => t(approve ? 'admin.regNotifyApproved' : 'admin.regNotifyRejected')).catch(() => {});
    } catch (err) {
      ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : tr('admin.failedToast'));
    }
  });

  bot.action(/^emp:(on|off):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery(T(ctx)('admin.notAuthorized'));
    const tr = T(ctx);
    const active = ctx.match[1] === 'on';
    const id = ctx.match[2];
    try {
      const t = await employeeService.setActive(ctx.from.id, id, active);
      if (!active && Number(t.telegram_user_id) === Number(ctx.from.id)) {
        return ctx.answerCbQuery(tr('admin.cannotDeactivateSelf'));
      }
      await ctx.answerCbQuery(active ? tr('admin.activatedToast') : tr('admin.deactivatedToast'));
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    } catch (err) {
      ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : tr('admin.failedToast'));
    }
  });

  bot.action(/^ov:(ok|no):(\d+)$/, async (ctx) => {
    const tr = T(ctx);
    const approver = ctx.state.employee;
    if (!approver) return ctx.answerCbQuery(tr('admin.noApprover'));
    try {
      const { session, actualMinutes, payableMinutes } = await approvalService.decide({
        approver,
        sessionId: ctx.match[2],
        approve: ctx.match[1] === 'ok',
        envAdminIds: config.adminTelegramIds,
      });
      await ctx.answerCbQuery(ctx.match[1] === 'ok' ? tr('admin.ovApprovedToast', { minutes: actualMinutes }) : tr('admin.rejectedToast'));
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      ctx.reply(ctx.match[1] === 'ok'
        ? tr('admin.ovApproved', { id: session.id, minutes: payableMinutes ?? '-' })
        : tr('admin.ovRejected', { id: session.id }));
    } catch (err) {
      ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : tr('admin.failedToast'));
    }
  });
}

// ---- Laporan & rekap ----
function registerAdminReports(bot, services) {
  const { reportService } = services;
  const isAdmin = (ctx) => ctx.state.isAdmin === true;
  const L = (ctx) => i18n.normalizeLang(ctx.state && ctx.state.employee && ctx.state.employee.language);
  const T = (ctx) => (key, params) => i18n.t(L(ctx), key, params);
  const E = (ctx, msg) => i18n.trError(L(ctx), msg);

  bot.command('export', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T(ctx)('admin.only'));
    const tr = T(ctx);
    const parts = (ctx.message.text || '').replace(/^\/export\s*/i, '').trim().split(/\s+/);
    const [from, to, extra] = parts;
    if (!from || !to) return ctx.reply(tr('admin.exportFormat'), { parse_mode: 'Markdown' });
    const isStatus = /^(approved|rejected|pending|completed|active)$/.test(extra || '');
    try {
      const filters = await reportService.buildFilters({
        from, to,
        status: isStatus ? extra : undefined,
        department: extra && !isStatus ? extra : undefined,
      });
      const { filePath, rowCount, totalActual } = await reportService.exportExcel(filters, `admin:${ctx.from.id}`, L(ctx));
      try {
        await ctx.replyWithDocument({ source: filePath, filename: `laporan-lembur-${from}-${to}.xlsx` });
        ctx.reply(tr('admin.exportSent', { rows: rowCount, minutes: totalActual }));
      } finally {
        fs.unlink(filePath, () => {}); // bersihkan file sementara
      }
    } catch (err) {
      ctx.reply(err.userMessage ? E(ctx, err.userMessage) : tr('admin.exportFailed'));
    }
  });

  bot.command('rekap', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(T(ctx)('admin.only'));
    const tr = T(ctx);
    const parts = (ctx.message.text || '').replace(/^\/rekap\s*/i, '').trim().split(/\s+/);
    const [from, to] = parts;
    try {
      const filters = await reportService.buildFilters({ from, to });
      const recap = await reportService.recap(filters, L(ctx));
      let msg = `${tr('admin.recapTitle', { range: recap.range })}\n${tr('admin.recapTotal', { minutes: recap.totalMinutes })}\n\n`;
      for (const e of recap.entries.slice(0, 20)) {
        msg += `${tr('admin.recapLine', { name: e.name, dept: e.department, minutes: e.minutes, sessions: e.sessions })}\n`;
      }
      ctx.reply(recap.entries.length ? msg : tr('admin.noApprovedData'));
    } catch (err) {
      ctx.reply(err.userMessage ? E(ctx, err.userMessage) : tr('admin.recapFailed'));
    }
  });
}

module.exports = { registerAdminHandlers };
