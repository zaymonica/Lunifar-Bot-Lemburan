'use strict';
const { mainMenu } = require('../keyboards');
const { ValidationError } = require('../../utils/errors');
const { sanitizeText } = require('../../services/employee.service');
const { toZonedParts } = require('../../utils/date-time');
const { navKeyboard } = require('../../services/payroll');

/** {y,m,d} hari ini pada zona waktu aplikasi. */
function todayInTz(timeZone) {
  const p = toZonedParts(new Date(), timeZone);
  const [y, m, d] = p.date.split('-').map(Number);
  return { y, m, d };
}

const HELP_TEXT = [
  '🤖 *Lunifar Overtime Bot*',
  '',
  'Bot pencatatan lembur pribadi — semua catatan langsung tersimpan, tanpa persetujuan admin.',
  '',
  'Perintah:',
  '/start — daftar atau mulai ulang',
  '/status — status lembur Anda',
  '/history — riwayat lembur',
  '/help — bantuan',
  '',
  'Menu:',
  '• 📝 INPUT LEMBUR — catat periode lembur manual (dukung tanggal lampau & multi-periode per hari)',
  '• 📋 Status Lembur Saya — rekap hari ini & akumulasi upah bulanan (NT$)',
  '• 📁 Riwayat Lembur — riwayat dikelompokkan per tanggal + total harian',
  '• 👤 Profil Saya — data Anda',
  '',
  'Catatan: input manual memakai format tanggal DD-MM-YYYY dan jam HH:MM (zona ' + 'waktu aplikasi).',
  'Durasi lintas tengah malam akan dikonfirmasi terlebih dahulu.',
  'Periode yang tumpang tindih memerlukan konfirmasi sebelum disimpan.',
].join('\n');

function registerCommonHandlers(bot, services) {
  const { employeeService, overtimeService } = services;
  const { config } = services;

  bot.start(async (ctx) => {
    const tgId = ctx.from.id;
    let emp = ctx.state.employee;
    if (emp && emp.status !== 'active') {
      // Aktivasi otomatis untuk status lama 'pending' (alur pribadi tanpa admin).
      try { emp = await employeeService.requireActiveEmployee(tgId); } catch (err) { emp = null; }
    }
    if (emp && emp.status === 'active' && emp.is_active) {
      return ctx.reply(`Selamat datang kembali, ${emp.full_name}!`, { reply_markup: mainMenu() });
    }
    if (emp && emp.status === 'rejected') {
      return ctx.reply('Registrasi Anda sebelumnya ditolak. Silakan daftar ulang dengan format di bawah.');
    }
    ctx.reply(
      'Selamat datang! Saya bot pencatatan lembur pribadi.\n' +
      'Untuk mendaftar, kirim data dengan format:\n\n' +
      '`/daftar Nama Lengkap | Nomor Karyawan | Departemen`\n\n' +
      'Contoh: `/daftar Budi Santoso | EMP001 | Produksi`\n' +
      '(Nomor karyawan boleh dikosongkan: `/daftar Budi Santoso | | Produksi`)\n\n' +
      'Registrasi langsung aktif tanpa persetujuan.',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('daftar', async (ctx) => {
    const raw = (ctx.message.text || '').replace(/^\/daftar\s*/i, '').trim();
    const parts = raw.split('|').map((p) => p.trim());
    if (parts.length < 2 || !parts[0]) {
      return ctx.reply('Format: `/daftar Nama Lengkap | Nomor Karyawan | Departemen`', { parse_mode: 'Markdown' });
    }
    try {
      const result = await employeeService.register({
        telegramUserId: ctx.from.id,
        fullName: parts[0],
        employeeNumber: parts[1] || null,
        department: parts[2] || 'Belum ditentukan',
      });
      ctx.reply(
        '✅ Registrasi berhasil dan langsung aktif. Gunakan "📝 INPUT LEMBUR" untuk mencatat lembur.',
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      ctx.reply(err.userMessage || 'Registrasi gagal.');
    }
  });

  bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }));
  bot.hears('❓ Bantuan', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'Markdown' }));

  /** Render status harian + rekap bulanan (dipakai command dan tombol menu). */
  async function renderStatus(ctx, emp) {
    const st = await overtimeService.myStatus(emp, config.timezone);
    let msg = st.running
      ? `🟢 Lembur berjalan sejak ${st.running.since} (${st.running.elapsedMinutes} menit).`
      : '⚪ Tidak ada lembur berjalan.';
    const today = await overtimeService.getDailyRecap(emp, todayInTz(config.timezone), config.timezone);
    if (today.text) msg += '\n\n' + today.text;
    const nowParts = toZonedParts(new Date(), config.timezone);
    const [curY, curM] = nowParts.date.split('-').map(Number);
    const monthly = await overtimeService.getMonthlyPayroll(emp, curY, curM);
    msg += '\n\n' + monthly.text;
    ctx.reply(msg, { reply_markup: { inline_keyboard: navKeyboard(curY, curM, curY, curM) } });
  }

  bot.command('status', async (ctx) => {
    try {
      const emp = await employeeService.requireActiveEmployee(ctx.from.id);
      await renderStatus(ctx, emp);
    } catch (err) {
      ctx.reply(err.userMessage || 'Gagal mengambil status.');
    }
  });

  bot.hears('📋 Status Lembur Saya', async (ctx) => {
    try {
      const emp = await employeeService.requireActiveEmployee(ctx.from.id);
      await renderStatus(ctx, emp);
    } catch (err) {
      ctx.reply(err.userMessage || 'Gagal mengambil status.');
    }
  });

  bot.command('profile', async (ctx) => {
    const emp = ctx.state.employee;
    if (!emp) return ctx.reply('Anda belum terdaftar. Gunakan /start.');
    ctx.reply(
      `👤 Profil\nNama: ${emp.full_name}\nID Karyawan: ${emp.employee_number || '-'}\nDepartemen: ${emp.department}\nStatus: ${emp.status}\nRole: ${emp.role}`
    );
  });

  bot.hears('👤 Profil Saya', (ctx) => {
    const emp = ctx.state.employee;
    if (!emp) return ctx.reply('Anda belum terdaftar. Gunakan /start.');
    ctx.reply(
      `👤 Profil\nNama: ${emp.full_name}\nID Karyawan: ${emp.employee_number || '-'}\nDepartemen: ${emp.department}\nStatus: ${emp.status}\nRole: ${emp.role}`
    );
  });
}

module.exports = { registerCommonHandlers, HELP_TEXT };
