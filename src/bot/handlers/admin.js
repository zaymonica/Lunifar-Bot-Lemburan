'use strict';
const fs = require('fs');
const { REGEX_CB } = require('../keyboards');

function registerAdminHandlers(bot, services) {
  const { employeeService, approvalService, reportService, overtimeRepo, config, notificationService } = services;
  const isAdmin = (ctx) => ctx.state.isAdmin === true;

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Perintah ini hanya untuk admin.');
    const [stats, pendingOv, statsOv] = await Promise.all([
      employeeService.employeeRepo.countByStatus(),
      approvalService.listPending(10),
      overtimeRepo.statsToday(),
    ]);
    const byStatus = Object.fromEntries(stats.map((s) => [s.status, s.cnt]));
    let msg =
      '🛠️ *Panel Admin*\n\n' +
      `Karyawan: aktif=${byStatus.active || 0}, pending=${byStatus.pending || 0}, ditolak=${byStatus.rejected || 0}, nonaktif=${byStatus.inactive || 0}\n` +
      `Lembur: aktif=${statsOv.active_count || 0}, pending=${statsOv.pending_count || 0}\n\n`;
    if (pendingOv.length) {
      msg += '*Lembur menunggu persetujuan:*\n';
      for (const s of pendingOv) msg += `• #${s.id} ${s.full_name} (${s.department})\n`;
    } else {
      msg += 'Tidak ada lembur menunggu persetujuan.\n';
    }
    msg += '\nPerintah admin:\n' +
      '`/karyawan [kata kunci]` — daftar/cari karyawan\n' +
      '`/pending` — daftar lembur pending\n' +
      '`/export DARI SAMPAI [departemen|status]` — ekspor Excel\n' +
      '`/rekap DARI SAMPAI` — rekap per karyawan';
    ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.hears('🛠️ Panel Admin', (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Perintah ini hanya untuk admin.');
    ctx.reply('Gunakan /admin untuk membuka panel.');
  });

  bot.command('karyawan', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Perintah ini hanya untuk admin.');
    const search = (ctx.message.text || '').replace(/^\/karyawan\s*/i, '').trim() || null;
    const rows = await employeeService.employeeRepo.list({ search, limit: 15 });
    if (!rows.length) return ctx.reply('Tidak ada karyawan cocok.');
    for (const e of rows) {
      const btn = [];
      if (e.status === 'pending') {
        btn.push([{ text: '✅ Setujui', callback_data: `reg:ok:${e.id}` }, { text: '❌ Tolak', callback_data: `reg:no:${e.id}` }]);
      } else if (e.status === 'active') {
        btn.push([{ text: '🚫 Nonaktifkan', callback_data: `emp:off:${e.id}` }]);
      } else if (e.status === 'inactive') {
        btn.push([{ text: '✅ Aktifkan', callback_data: `emp:on:${e.id}` }]);
      }
      await ctx.reply(
        `👤 #${e.id} ${e.full_name}\nNIK: ${e.employee_number || '-'}\nDept: ${e.department}\nStatus: ${e.status}\nTG ID: ${e.telegram_user_id}`,
        { reply_markup: btn.length ? { inline_keyboard: btn } : undefined }
      );
    }
  });

  bot.command('pending', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Perintah ini hanya untuk admin.');
    const rows = await approvalService.listPending(15);
    if (!rows.length) return ctx.reply('Tidak ada lembur menunggu persetujuan.');
    for (const s of rows) {
      await ctx.reply(
        `⏳ Lembur #${s.id}\nKaryawan: ${s.full_name} (${s.department})\nMulai: ${String(s.start_at).replace('T', ' ')} UTC\nSelesai: ${String(s.end_at).replace('T', ' ')} UTC\nCatatan: ${s.note || '-'}`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Setujui', callback_data: `ov:ok:${s.id}` },
          { text: '❌ Tolak', callback_data: `ov:no:${s.id}` },
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

  bot.action(/^reg:(ok|no):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Tidak berwenang.');
    const approve = ctx.match[1] === 'ok';
    const id = ctx.match[2];
    try {
      const t = await employeeService.decideRegistration(ctx.from.id, id, approve);
      await ctx.answerCbQuery(approve ? 'Disetujui.' : 'Ditolak.');
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      ctx.reply(`${approve ? '✅' : '❌'} Registrasi #${id} (${t.full_name}) ${approve ? 'disetujui' : 'ditolak'}.`);
      notificationService.sendTo(id, approve
        ? '✅ Registrasi Anda disetujui. Anda dapat mulai mencatat lembur.'
        : '❌ Registrasi Anda ditolak admin. Hubungi admin untuk info lebih lanjut.').catch(() => {});
    } catch (err) {
      ctx.answerCbQuery(err.userMessage || 'Gagal.');
    }
  });

  bot.action(/^emp:(on|off):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery('Tidak berwenang.');
    const active = ctx.match[1] === 'on';
    const id = ctx.match[2];
    try {
      const t = await employeeService.setActive(ctx.from.id, id, active);
      if (!active && Number(t.telegram_user_id) === Number(ctx.from.id)) {
        return ctx.answerCbQuery('Tidak dapat menonaktifkan diri sendiri.');
      }
      await ctx.answerCbQuery(active ? 'Diaktifkan.' : 'Dinonaktifkan.');
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    } catch (err) {
      ctx.answerCbQuery(err.userMessage || 'Gagal.');
    }
  });

  bot.action(/^ov:(ok|no):(\d+)$/, async (ctx) => {
    const approver = ctx.state.employee;
    if (!approver) return ctx.answerCbQuery('Data approver tidak ditemukan. Daftar dulu via /start.');
    try {
      const { session, actualMinutes, payableMinutes } = await approvalService.decide({
        approver,
        sessionId: ctx.match[2],
        approve: ctx.match[1] === 'ok',
        envAdminIds: config.adminTelegramIds,
      });
      await ctx.answerCbQuery(ctx.match[1] === 'ok' ? `Disetujui (${actualMinutes} menit).` : 'Ditolak.');
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      ctx.reply(ctx.match[1] === 'ok'
        ? `✅ Lembur #${session.id} disetujui. Terhitung: ${payableMinutes ?? '-'} menit.`
        : `❌ Lembur #${session.id} ditolak.`);
    } catch (err) {
      ctx.answerCbQuery(err.userMessage || 'Gagal.');
    }
  });
}

// ---- Laporan & rekap ----
function registerAdminReports(bot, services) {
  const { reportService } = services;
  const isAdmin = (ctx) => ctx.state.isAdmin === true;

  bot.command('export', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Perintah ini hanya untuk admin.');
    const parts = (ctx.message.text || '').replace(/^\/export\s*/i, '').trim().split(/\s+/);
    const [from, to, extra] = parts;
    if (!from || !to) return ctx.reply('Format: `/export YYYY-MM-DD YYYY-MM-DD [departemen|status]`', { parse_mode: 'Markdown' });
    const isStatus = /^(approved|rejected|pending|completed|active)$/.test(extra || '');
    try {
      const filters = await reportService.buildFilters({
        from, to,
        status: isStatus ? extra : undefined,
        department: extra && !isStatus ? extra : undefined,
      });
      const { filePath, rowCount, totalActual } = await reportService.exportExcel(filters, `admin:${ctx.from.id}`);
      try {
        await ctx.replyWithDocument({ source: filePath, filename: `laporan-lembur-${from}-${to}.xlsx` });
        ctx.reply(`✅ Laporan terkirim (${rowCount} baris, total ${totalActual} menit).`);
      } finally {
        fs.unlink(filePath, () => {}); // bersihkan file sementara
      }
    } catch (err) {
      ctx.reply(err.userMessage || 'Gagal membuat laporan.');
    }
  });

  bot.command('rekap', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply('Perintah ini hanya untuk admin.');
    const parts = (ctx.message.text || '').replace(/^\/rekap\s*/i, '').trim().split(/\s+/);
    const [from, to] = parts;
    try {
      const filters = await reportService.buildFilters({ from, to });
      const recap = await reportService.recap(filters);
      let msg = `📊 Rekap ${recap.range}\nTotal terhitung: ${recap.totalMinutes} menit\n\n`;
      for (const e of recap.entries.slice(0, 20)) {
        msg += `• ${e.name} (${e.department}): ${e.minutes} menit / ${e.sessions} sesi\n`;
      }
      ctx.reply(recap.entries.length ? msg : 'Tidak ada data disetujui pada rentang ini.');
    } catch (err) {
      ctx.reply(err.userMessage || 'Gagal membuat rekap.');
    }
  });
}

module.exports = { registerAdminHandlers };
