'use strict';
const { requireActive } = require('../middleware/auth');
const {
  parseTimeHHMM, resolvePeriod, formatDurationId, formatDailyRecap, periodsOverlap, rowNetMinutes,
} = require('../../services/overtime-input');
const { formatInTz, toZonedParts, zonedWallToUtc } = require('../../utils/date-time');
const { navKeyboard, parseMonthParam } = require('../../services/payroll');
const { todayInTz, parseCalDate, formatDateId, calendarKeyboard } = require('../../services/calendar');
const { OvertimeService } = require('../../services/overtime.service');

const WIZARD_TTL_MS = 15 * 60 * 1000;
const HISTORY_PER_PAGE = 5;

function registerOvertimeHandlers(bot, services) {
  const { overtimeService, employeeService, config, overtimeRepo } = services;
  const tz = config.timezone;

  // ---- Wizard input lembur manual (in-memory, per user) ----
  const wizard = new Map(); // telegramUserId -> { step, data, expiresAt }

  function getState(ctx) {
    const st = wizard.get(ctx.from.id);
    if (!st) return null;
    if (Date.now() > st.expiresAt) { wizard.delete(ctx.from.id); return null; }
    return st;
  }
  const setState = (ctx, step, data) => wizard.set(ctx.from.id, { step, data: data || {}, expiresAt: Date.now() + WIZARD_TTL_MS });

  // ---- Wizard EDIT catatan lembur (in-memory, per user, terpisah dari input) ----
  const editWizard = new Map(); // telegramUserId -> { sessionId, orig, data, step, expiresAt }

  function getEditState(ctx) {
    const st = editWizard.get(ctx.from.id);
    if (!st) return null;
    if (Date.now() > st.expiresAt) { editWizard.delete(ctx.from.id); return null; }
    return st;
  }
  const setEditState = (ctx, step, patch) => {
    const prev = editWizard.get(ctx.from.id) || {};
    editWizard.set(ctx.from.id, { ...prev, ...patch, step, expiresAt: Date.now() + WIZARD_TTL_MS });
  };

  const hhmm = (t) => `${String(t.h).padStart(2, '0')}:${String(t.min).padStart(2, '0')}`;

  /** Bagian tanggal/jam lokal (Asia/Taipei) dari instan UTC: {date:'YYYY-MM-DD', ymd:{y,m,d}, h, min}. */
  const localParts = (date) => {
    const p = toZonedParts(date, tz);
    return { date: p.date, ymd: p.ymd, h: Number(p.time.slice(0, 2)), min: Number(p.time.slice(3, 5)) };
  };

  /** Ambil employee untuk callback (service-based bila tersedia, else middleware). */
  const getEmployee = async (ctx) => (employeeService
    ? employeeService.requireActiveEmployee(ctx.from.id)
    : requireActive(ctx));

  // Keyboard kecil untuk mengganti tanggal setelah tanggal terpilih.
  const dateChangeKeyboard = () => ({
    reply_markup: {
      inline_keyboard: [
        [{ text: '📅 Pilih Tanggal Lain', callback_data: 'cal:open' }],
        [{ text: '❌ Batal', callback_data: 'cal:cancel' }],
      ],
    },
  });

  const promptStart = (data) => `📝 Input Lembur Manual\n\n`
    + `Tanggal terpilih: ${formatDateId(data.date)}\n\n`
    + `Langkah 2/3 — Kirim jam mulai dengan format HH:MM.\nContoh: 16:30\n\n`
    + `Salah tanggal? Ketuk "📅 Pilih Tanggal Lain" untuk membuka kalender.\n`
    + `Ketik /batal untuk membatalkan.`;

  const startInput = async (ctx) => {
    try {
      requireActive(ctx);
      // Tanggal hari ini menurut zona waktu Asia/Taipei (bukan timezone server).
      const date = todayInTz(tz);
      setState(ctx, 'start', { date });
      ctx.reply(promptStart({ date }), dateChangeKeyboard());
    } catch (err) {
      ctx.reply(err.userMessage || 'Gagal memulai input lembur.');
    }
  };

  const cancelInput = async (ctx) => {
    const had = wizard.delete(ctx.from.id) | editWizard.delete(ctx.from.id);
    ctx.reply(had ? '❌ Input lembur dibatalkan. Tidak ada data yang disimpan.' : 'Tidak ada input lembur yang sedang berjalan.');
  };

  /** Ringkasan periode sebelum konfirmasi (kotor / istirahat / bersih). */
  function buildSummary(data, crossMidnight, overlapping) {
    const gross = data.minutes;
    const brk = data.breakMinutes || 0;
    const lines = [
      '📋 Ringkasan input lembur',
      `• Tanggal: ${formatDateId(data.date)}`,
      `• Mulai: ${String(data.start.h).padStart(2, '0')}:${String(data.start.min).padStart(2, '0')}`,
      `• Selesai: ${String(data.end.h).padStart(2, '0')}:${String(data.end.min).padStart(2, '0')}`
        + (crossMidnight ? ' (hari berikutnya)' : ''),
      `• Durasi kotor: ${formatDurationId(gross)}`,
      `• Istirahat: ${formatDurationId(brk)}`,
      `• Durasi bersih: ${formatDurationId(gross - brk)}`,
    ];
    if (overlapping && overlapping.length) {
      lines.push('', `⚠️ PERINGATAN: periode ini TUMPANG TINDIH dengan ${overlapping.length} catatan yang sudah ada:`
        + '\n' + overlapping.map((r) => `  - ${formatInTz(new Date(r.start_at), tz)} → ${formatInTz(new Date(r.end_at), tz)}`).join('\n'));
    }
    lines.push('', 'Simpan periode ini? Balas "ya" untuk menyimpan atau "tidak" untuk membatalkan.');
    return lines.join('\n');
  }

  /** Keyboard pilihan durasi istirahat (default 0 menit — tidak pernah dipotong otomatis). */
  const breakKeyboard = () => ({
    reply_markup: {
      inline_keyboard: [
        [{ text: '☕ Tidak ada istirahat (0 menit)', callback_data: 'brk:0' }],
        [{ text: '☕ Istirahat 30 menit', callback_data: 'brk:30' }],
        [{ text: '☕ Istirahat 45 menit', callback_data: 'brk:45' }],
        [{ text: '☕ Istirahat 60 menit', callback_data: 'brk:60' }],
        [{ text: '✏️ Input manual (menit)', callback_data: 'brk:custom' }],
        [{ text: '❌ Batal', callback_data: 'brk:cancel' }],
      ],
    },
  });

  /** Setelah jam selesai valid: tampilkan durasi kotor + pilihan istirahat. */
  function promptBreak(ctx, data) {
    setState(ctx, 'break', data);
    return ctx.reply(
      `⏱️ Durasi kotor: ${formatDurationId(data.minutes)}.\n\n`
      + 'Pilih durasi istirahat (durasi bersih = kotor − istirahat). '
      + 'Default: 0 menit — tidak ada pemotongan otomatis.',
      breakKeyboard()
    );
  }

  /** Setelah lintas-hari dikonfirmasi/ditolak: hitung durasi kotor, lanjut ke istirahat. */
  function proceedAfterCross(ctx, data, crossMidnight) {
    let period;
    try {
      period = resolvePeriod(data.date, data.start, data.end, { crossMidnight, timezone: tz });
    } catch (err) {
      setState(ctx, 'end', data);
      return ctx.reply(`❌ ${err.message}\nKirim ulang jam selesai (HH:MM), atau /batal.`);
    }
    data.crossMidnight = crossMidnight;
    data.minutes = period.minutes;
    return promptBreak(ctx, data);
  }

  /** Validasi akhir: duplikat, tumpang tindih → minta konfirmasi (data.breakMinutes sudah dipilih). */
  async function evaluatePeriod(ctx, emp, data) {
    const crossMidnight = !!data.crossMidnight;
    let period;
    try {
      period = resolvePeriod(data.date, data.start, data.end, { crossMidnight, timezone: tz });
    } catch (err) {
      wizard.delete(ctx.from.id);
      return ctx.reply(`❌ Periode tidak valid: ${err.message}\nInput dibatalkan. Mulai ulang dengan "📝 INPUT LEMBUR".`);
    }
    data.minutes = period.minutes;
    const dayStart = zonedWallToUtc(data.date.y, data.date.m, data.date.d, 0, 0, tz);
    const existing = await overtimeRepo.listByEmployeeAndWindow(
      emp.id, new Date(dayStart.getTime() - 12 * 3600e3), new Date(dayStart.getTime() + 36 * 3600e3)
    );
    const dup = existing.find((r) => r.end_at
      && new Date(r.start_at).getTime() === period.startUtc.getTime()
      && new Date(r.end_at).getTime() === period.endUtc.getTime()
      && r.status !== 'rejected');
    if (dup) {
      wizard.delete(ctx.from.id);
      return ctx.reply('❌ Periode yang identik (mulai & selesai sama) sudah pernah dicatat untuk tanggal ini. Input dibatalkan.');
    }
    const overlapping = existing.filter((r) => r.status !== 'rejected' && r.end_at
      && periodsOverlap(new Date(r.start_at), new Date(r.end_at), period.startUtc, period.endUtc));

    setState(ctx, 'confirm', data);
    ctx.reply(buildSummary(data, crossMidnight, overlapping));
  }

  async function saveConfirmed(ctx, emp, data) {
    try {
      const result = await overtimeService.createManualPeriod(emp, {
        date: data.date, start: data.start, end: data.end, crossMidnight: data.crossMidnight,
        breakMinutes: data.breakMinutes || 0,
      }, { force: true });
      const lines = [
        '✅ Periode lembur tersimpan.',
        `• Tanggal: ${formatDateId(data.date)}`,
        `• Mulai: ${String(data.start.h).padStart(2, '0')}:${String(data.start.min).padStart(2, '0')} — Selesai: ${String(data.end.h).padStart(2, '0')}:${String(data.end.min).padStart(2, '0')}`,
        `• Durasi kotor: ${formatDurationId(result.grossMinutes)}`,
        `• Istirahat: ${formatDurationId(result.breakMinutes)}`,
        `• Durasi bersih: ${formatDurationId(result.actualMinutes)}`,
        `• Total lembur harian (semua periode, bersih): ${formatDurationId(result.dayTotalMinutes)}`,
        '',
        'Kirim "📝 INPUT LEMBUR" untuk menambah periode lain pada tanggal yang sama atau berbeda.',
      ];
      wizard.delete(ctx.from.id);
      ctx.reply(lines.join('\n'));
    } catch (err) {
      // Jangan hapus state wizard agar pengguna bisa mencoba konfirmasi lagi.
      ctx.reply(`❌ Gagal menyimpan periode lembur: ${err.userMessage || err.message || 'kesalahan internal'}\nBalas "ya" untuk mencoba lagi, atau /batal untuk membatalkan.`);
    }
  }

  /** Router teks untuk wizard edit (langkah jam mulai/selesai, lintas hari, istirahat manual). */
  async function handleEditText(ctx, ed) {
    const text = (ctx.message && ctx.message.text ? ctx.message.text : '').trim();
    const lower = text.toLowerCase();
    if (lower === '/batal' || lower === 'batal') {
      editWizard.delete(ctx.from.id);
      return ctx.reply('❌ Edit lembur dibatalkan. Tidak ada perubahan yang disimpan.');
    }
    if (ed.step === 'start' || ed.step === 'end') {
      let t;
      try { t = parseTimeHHMM(text); } catch (err) {
        return ctx.reply(`❌ ${err.message}\nCoba lagi, atau /batal.`);
      }
      ed.data[ed.step] = t;
      if (ed.step === 'start') {
        setEditState(ctx, 'menu', { data: ed.data });
        return showEditMenu(ctx, getEditState(ctx));
      }
      // step 'end': validasi periode; minta konfirmasi lintas hari bila perlu.
      try {
        const period = resolvePeriod(ed.data.date, ed.data.start, ed.data.end, { crossMidnight: false, timezone: tz });
        ed.data.minutes = period.minutes;
        setEditState(ctx, 'menu', { data: ed.data });
        return showEditMenu(ctx, getEditState(ctx));
      } catch (err) {
        if (err.code === 'CROSS_MIDNIGHT') {
          setEditState(ctx, 'cross', { data: ed.data });
          return ctx.reply('⏰ Jam selesai lebih awal dari jam mulai.\nApakah lembur berakhir pada hari berikutnya? Balas "ya" atau "tidak".');
        }
        return ctx.reply(`❌ ${err.message}\nSilakan kirim ulang jam selesai (HH:MM), atau /batal.`);
      }
    }
    if (ed.step === 'cross') {
      if (lower === 'ya' || lower === 'tidak') {
        ed.data.crossMidnight = lower === 'ya';
        try {
          const period = resolvePeriod(ed.data.date, ed.data.start, ed.data.end, { crossMidnight: ed.data.crossMidnight, timezone: tz });
          ed.data.minutes = period.minutes;
          setEditState(ctx, 'menu', { data: ed.data });
          return showEditMenu(ctx, getEditState(ctx));
        } catch (err) {
          setEditState(ctx, 'end', { data: ed.data });
          return ctx.reply(`❌ ${err.message}\nKirim ulang jam selesai (HH:MM), atau /batal.`);
        }
      }
      return ctx.reply('Balas "ya" atau "tidak" — apakah lembur berakhir pada hari berikutnya?');
    }
    if (ed.step === 'brk_custom') {
      const m = /^\d{1,4}$/.exec(text);
      if (!m) {
        return ctx.reply('❌ Masukkan jumlah menit istirahat sebagai bilangan bulat, contoh: 40. Atau /batal.');
      }
      const minutes = Number(m[0]);
      let gross = ed.data.minutes;
      if (!Number.isInteger(gross)) {
        try { gross = recomputeEditPeriod(ed).minutes; } catch (err) { gross = null; }
      }
      if (gross === null || minutes >= gross) {
        return ctx.reply(`❌ Istirahat ${minutes} menit melebihi atau sama dengan durasi kotor${gross ? ` ${gross} menit` : ''} — durasi bersih tidak boleh 0 atau negatif.\nCoba lagi, atau /batal.`);
      }
      ed.data.breakMinutes = minutes;
      setEditState(ctx, 'menu', { data: ed.data });
      return showEditMenu(ctx, getEditState(ctx));
    }
    if (ed.step === 'menu' || ed.step === 'brk' || ed.step === 'date' || ed.step === 'review') {
      return ctx.reply('Silakan gunakan tombol di atas, ketik /batal untuk membatalkan edit.');
    }
    editWizard.delete(ctx.from.id);
    return ctx.reply('❌ Alur edit tidak dikenali — dibatalkan.');
  }

  // Intersep teks HANYA jika pengguna sedang dalam alur input ATAU edit;
  // jika tidak, teruskan ke handler berikutnya (menu, admin, dsb. tetap berfungsi).
  bot.on('text', async (ctx, next) => {
    const st = getState(ctx);
    if (!st) {
      const ed = getEditState(ctx);
      if (!ed) return next();
      return handleEditText(ctx, ed);
    }
    const emp = requireActive(ctx);
    const text = (ctx.message.text || '').trim();
    const lower = text.toLowerCase();

    if (st.step === 'cross' && (lower === 'ya' || lower === 'tidak')) {
      if (lower === 'ya') return proceedAfterCross(ctx, st.data, true);
      setState(ctx, 'end', st.data);
      return ctx.reply('Baik, lembur dianggap berakhir di hari yang sama.\nKirim ulang jam selesai (HH:MM) yang tepat, atau /batal.');
    }
    if (st.step === 'confirm') {
      if (lower === 'ya') return saveConfirmed(ctx, emp, st.data);
      if (lower === 'tidak') { wizard.delete(ctx.from.id); return ctx.reply('❌ Input lembur dibatalkan. Tidak ada data yang disimpan.'); }
      return ctx.reply('Balas "ya" untuk menyimpan atau "tidak" untuk membatalkan.');
    }
    if (st.step === 'start') {
      try { st.data.start = parseTimeHHMM(text); } catch (err) {
        return ctx.reply(`❌ ${err.message}\nCoba lagi, atau /batal.`);
      }
      setState(ctx, 'end', st.data);
      return ctx.reply('Langkah 3/3 — Masukkan jam selesai dengan format HH:MM.\nContoh: 17:30');
    }
    if (st.step === 'end') {
      try { st.data.end = parseTimeHHMM(text); } catch (err) {
        return ctx.reply(`❌ ${err.message}\nCoba lagi, atau /batal.`);
      }
      let period;
      try {
        period = resolvePeriod(st.data.date, st.data.start, st.data.end, { crossMidnight: false, timezone: tz });
      } catch (err) {
        if (err.code === 'CROSS_MIDNIGHT') {
          setState(ctx, 'cross', st.data);
          return ctx.reply(
            '⏰ Jam selesai lebih awal dari jam mulai.\nApakah lembur berakhir pada hari berikutnya? Balas "ya" atau "tidak".'
          );
        }
        return ctx.reply(`❌ ${err.message}\nSilakan kirim ulang jam selesai (HH:MM), atau /batal.`);
      }
      st.data.minutes = period.minutes;
      return promptBreak(ctx, st.data);
    }
    if (st.step === 'break_custom') {
      const m = /^\d{1,4}$/.exec(text);
      if (!m) {
        return ctx.reply(`❌ Masukkan jumlah menit istirahat sebagai bilangan bulat (0–${Math.max(0, st.data.minutes - 1)}), contoh: 40. Atau /batal.`);
      }
      const minutes = Number(m[0]);
      const err = applyBreakChoice(ctx, st.data, minutes);
      if (err) return ctx.reply(`❌ ${err}\nCoba lagi (bilangan bulat 0–${Math.max(0, st.data.minutes - 1)}), atau /batal.`);
      return undefined;
    }
    if (st.step === 'break') {
      return ctx.reply('☕ Silakan pilih durasi istirahat lewat tombol di atas (atau "✏️ Input manual"), ketik /batal untuk membatalkan.');
    }
    if (lower === '/batal' || lower === 'batal') return cancelInput(ctx);
    wizard.delete(ctx.from.id);
    return ctx.reply('❌ Alur input tidak dikenali — dibatalkan.');
  });

  // ---- Pilihan durasi istirahat (callback "brk:") ----
  // Terikat pada wizard ctx.from.id; hanya valid di langkah pemilihan istirahat.
  function getWizardForBreak(ctx) {
    const st = getState(ctx);
    if (!st) return { err: 'Sesi input sudah berakhir atau kedaluwarsa. Tekan "📝 INPUT LEMBUR" untuk memulai lagi.' };
    if (st.step !== 'break' && st.step !== 'break_custom') {
      return { err: 'Pemilihan istirahat sudah selesai untuk input ini. Balas "ya"/"tidak" pada ringkasan, atau /batal.' };
    }
    return { st };
  }

  /** Terapkan pilihan istirahat; kembalikan pesan error (string) jika tidak valid. */
  function applyBreakChoice(ctx, data, minutes) {
    if (!Number.isInteger(minutes) || minutes < 0) return 'Jumlah menit istirahat tidak valid.';
    if (minutes >= data.minutes) {
      return `Istirahat ${minutes} menit melebihi durasi kotor ${data.minutes} menit — durasi bersih tidak boleh 0 atau negatif.`;
    }
    data.breakMinutes = minutes;
    setState(ctx, 'confirm', data);
    evaluatePeriod(ctx, requireActive(ctx), data)
      .catch(() => { wizard.delete(ctx.from.id); ctx.reply('❌ Gagal memproses input. Mulai ulang dengan "📝 INPUT LEMBUR".'); });
    return null;
  }

  bot.action(/^brk:(0|30|45|60|custom|cancel)$/, async (ctx) => {
    const g = getWizardForBreak(ctx);
    if (g.err) {
      await ctx.answerCbQuery(`❌ ${g.err}`).catch(() => {});
      return undefined;
    }
    const choice = ctx.match[1];
    if (choice === 'cancel') {
      wizard.delete(ctx.from.id);
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply('❌ Input lembur dibatalkan. Tidak ada data yang disimpan.');
    }
    if (choice === 'custom') {
      setState(ctx, 'break_custom', g.st.data);
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(
        `✏️ Kirim jumlah menit istirahat sebagai bilangan bulat (0–${Math.max(0, g.st.data.minutes - 1)}).\nContoh: 40. Atau /batal.`
      );
    }
    const err = applyBreakChoice(ctx, g.st.data, Number(choice));
    await ctx.answerCbQuery().catch(() => {});
    if (err) return ctx.reply(`❌ ${err}`);
    return undefined;
  });

  bot.command('batal', cancelInput);
  bot.hears('❌ Batalkan Input', cancelInput);

  // ---- Kalender interaktif: pemilihan tanggal input lembur (callback "cal:") ----
  // Semua callback diikat ke wizard milik ctx.from.id; pengguna lain atau sesi
  // kedaluwarsa mendapat pesan ramah, bukan error. Tidak boleh mengganggu langkah
  // konfirmasi (confirm/cross) yang berbasis teks.

  /** Wizard input ATAU edit aktif & berada di langkah pemilihan tanggal? */
  function getWizardForCalendar(ctx) {
    const st = getState(ctx);
    if (st && st.step === 'start') return { kind: 'input', st };
    const ed = getEditState(ctx);
    if (ed && ed.step === 'date') return { kind: 'edit', st: ed };
    if (st) return { err: 'Pemilihan tanggal sudah selesai untuk input ini. Gunakan /batal lalu mulai ulang jika ingin mengubah tanggal.' };
    if (ed) return { err: 'Pemilihan tanggal sudah selesai untuk edit ini. Kembali ke menu Edit untuk memilih tanggal lagi.' };
    return { err: 'Sesi sudah berakhir atau kedaluwarsa. Buka kembali 📝 INPUT LEMBUR atau 📁 Riwayat Lembur.' };
  }

  const calGuard = async (ctx) => {
    const g = getWizardForCalendar(ctx);
    if (g.err) {
      await ctx.answerCbQuery(`❌ ${g.err}`).catch(() => {});
      return null;
    }
    return g;
  };

  // Buka kalender: mulai dari bulan tanggal yang sedang terpilih.
  bot.action(/^cal:open$/, async (ctx) => {
    const g = await calGuard(ctx);
    if (!g) return undefined;
    const view = { y: g.st.data.date.y, m: g.st.data.date.m };
    try {
      await ctx.editMessageText(
        `📅 Pilih tanggal lembur — tampilan ${formatDateId({ y: view.y, m: view.m, d: 1 }).replace(/^1 /, '')}\n`
        + `Ketik /batal untuk membatalkan.`,
        { reply_markup: { inline_keyboard: calendarKeyboard(view.y, view.m) } }
      );
    } catch (e) {
      ctx.reply('📅 Pilih tanggal lembur.', { reply_markup: { inline_keyboard: calendarKeyboard(view.y, view.m) } });
    }
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  // Navigasi bulan: callback membawa bulan target yang sudah dihitung keyboard
  // (termasuk rollover antar tahun, mis. Des 2026 → cal:next:2027-01).
  bot.action(/^cal:(prev|next):(\d{4})-(\d{2})$/, async (ctx) => {
    const g = await calGuard(ctx);
    if (!g) return undefined;
    const y = Number(ctx.match[2]);
    const m = Number(ctx.match[3]);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) {
      await ctx.answerCbQuery('Bulan tidak valid.').catch(() => {});
      return undefined;
    }
    try {
      await ctx.editMessageText(
        `📅 Pilih tanggal lembur — tampilan ${formatDateId({ y, m, d: 1 }).replace(/^1 /, '')}\nKetik /batal untuk membatalkan.`,
        { reply_markup: { inline_keyboard: calendarKeyboard(y, m) } }
      );
    } catch (e) {
      ctx.reply(`📅 Pilih tanggal lembur — ${formatDateId({ y, m, d: 1 }).replace(/^1 /, '')}.`,
        { reply_markup: { inline_keyboard: calendarKeyboard(y, m) } });
    }
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  // Pilih tanggal tertentu (atau tombol "Hari Ini") → input: lanjut jam mulai;
  // edit: kembali ke menu edit dengan tanggal baru.
  const pickDate = (date) => async (ctx) => {
    const g = await calGuard(ctx);
    if (!g) return undefined;
    if (!date) {
      await ctx.answerCbQuery('Tanggal tidak valid.').catch(() => {});
      return undefined;
    }
    const st = g.st;
    st.data.date = date;
    if (g.kind === 'edit') {
      setEditState(ctx, 'menu', { data: st.data });
      await showEditMenu(ctx, getEditState(ctx));
      await ctx.answerCbQuery(`Tanggal: ${formatDateId(date)}`).catch(() => {});
      return undefined;
    }
    setState(ctx, 'start', st.data);
    try {
      await ctx.editMessageText(promptStart(st.data), dateChangeKeyboard());
    } catch (e) {
      ctx.reply(promptStart(st.data), dateChangeKeyboard());
    }
    await ctx.answerCbQuery(`Tanggal: ${formatDateId(date)}`).catch(() => {});
    return undefined;
  };

  bot.action(/^cal:sel:(\d{4})-(\d{2})-(\d{2})$/, (ctx) => pickDate(parseCalDate(`${ctx.match[1]}-${ctx.match[2]}-${ctx.match[3]}`))(ctx));
  bot.action(/^cal:today$/, (ctx) => pickDate(todayInTz(tz))(ctx));

  // Batal lewat tombol kalender (input maupun edit).
  bot.action(/^cal:cancel$/, async (ctx) => {
    const had = wizard.delete(ctx.from.id) | editWizard.delete(ctx.from.id);
    try {
      await ctx.editMessageText('❌ Input lembur dibatalkan. Tidak ada data yang disimpan.');
    } catch (e) {
      ctx.reply('❌ Input lembur dibatalkan. Tidak ada data yang disimpan.');
    }
    await ctx.answerCbQuery(had ? 'Dibatalkan.' : 'Tidak ada sesi.').catch(() => {});
    return undefined;
  });

  // Tombol non-aktif (judul bulan, sel kosong).
  bot.action(/^cal:noop$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  // ---- Riwayat: dikelompokkan per tanggal + total harian + tombol detail/Edit ----
  const loadOwnHistory = async (ctx) => {
    const emp = await getEmployee(ctx);
    const rows = await overtimeRepo.listByEmployee(emp.id, { limit: 100 });
    return rows.filter((r) => r.end_at && r.status !== 'active');
  };

  const historyPages = (finished) => Math.max(1, Math.ceil(finished.length / HISTORY_PER_PAGE));

  const historyPageKeyboard = (finished, page) => {
    const pages = historyPages(finished);
    const p = Math.min(Math.max(0, page), pages - 1);
    const slice = finished.slice(p * HISTORY_PER_PAGE, p * HISTORY_PER_PAGE + HISTORY_PER_PAGE);
    const kb = slice.map((r) => {
      const { net } = rowNetMinutes(r);
      const s = localParts(new Date(r.start_at));
      const e = localParts(new Date(r.end_at));
      const tag = r.status === 'pending' ? ' (data lama)' : '';
      return [{
        text: `${formatDateId(s.ymd)} ${hhmm(s)}–${hhmm(e)} · ${formatDurationId(net)}${tag}`,
        callback_data: `ed:view:${r.id}`,
      }];
    });
    const nav = [];
    if (p > 0) nav.push({ text: '◀️ Sebelumnya', callback_data: `ed:page:${p - 1}` });
    nav.push({ text: `Hal. ${p + 1}/${pages}`, callback_data: 'ed:noop' });
    if (p < pages - 1) nav.push({ text: 'Berikutnya ▶️', callback_data: `ed:page:${p + 1}` });
    kb.push(nav);
    return { page: p, keyboard: kb };
  };

  const historyPageText = (finished, page) => {
    const p = Math.min(Math.max(0, page), historyPages(finished) - 1);
    const slice = finished.slice(p * HISTORY_PER_PAGE, p * HISTORY_PER_PAGE + HISTORY_PER_PAGE);
    const groups = new Map();
    for (const r of slice) {
      const key = toZonedParts(new Date(r.start_at), tz).date;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const parts = ['📁 Riwayat lembur (per tanggal)', '', 'Ketuk salah satu catatan untuk melihat detail & mengedit.'];
    for (const groupRows of groups.values()) {
      const recap = formatDailyRecap(groupRows, tz);
      if (recap) parts.push('', recap);
    }
    return parts.join('\n');
  };

  const renderHistoryPage = (ctx, finished, page, edit = false) => {
    const { page: p, keyboard } = historyPageKeyboard(finished, page);
    const text = historyPageText(finished, p);
    const markup = { reply_markup: { inline_keyboard: keyboard } };
    if (edit) {
      return ctx.editMessageText(text, markup).catch(() => ctx.reply(text, markup));
    }
    return ctx.reply(text, markup);
  };

  const history = async (ctx) => {
    try {
      const finished = await loadOwnHistory(ctx);
      if (!finished.length) return ctx.reply('Belum ada riwayat lembur.');
      return renderHistoryPage(ctx, finished, 0);
    } catch (err) {
      return ctx.reply(err.userMessage || 'Gagal mengambil riwayat.');
    }
  };

  // ---- Detail catatan + tombol Edit (callback "ed:view") ----
  const statusLabel = (s) => ({
    completed: 'tercatat', pending: 'menunggu persetujuan (data lama)',
    approved: 'disetujui', rejected: 'ditolak', active: 'berjalan',
  }[s] || s);

  const sessionDetailText = (row) => {
    const { gross, breakMinutes, net } = rowNetMinutes(row);
    const s = localParts(new Date(row.start_at));
    const e = localParts(new Date(row.end_at));
    const editable = OvertimeService.EDITABLE_STATUSES.includes(row.status);
    return [
      `📄 Detail catatan lembur #${row.id}`,
      `• Status: ${statusLabel(row.status)}`,
      `• Tanggal: ${formatDateId(s.ymd)}`,
      `• Mulai: ${hhmm(s)}`,
      `• Selesai: ${hhmm(e)}${s.date !== e.date ? ' (hari berikutnya)' : ''}`,
      `• Durasi kotor: ${formatDurationId(gross)}`,
      `• Istirahat: ${formatDurationId(breakMinutes)}`,
      `• Durasi bersih: ${formatDurationId(net)}`,
      editable ? '' : '\nℹ️ Catatan ini tidak dapat diedit (status bukan "tercatat"/"data lama").',
    ].filter((l) => l !== '').join('\n');
  };

  const detailKeyboard = (id, status) => ({ reply_markup: { inline_keyboard: [
    ...(OvertimeService.EDITABLE_STATUSES.includes(status)
      ? [[{ text: '✏️ Edit Catatan', callback_data: `ed:edit:${id}` }]]
      : []),
    [{ text: '◀️ Kembali ke Riwayat', callback_data: 'ed:page:0' }],
  ] } });

  bot.action(/^ed:view:(\d+)$/, async (ctx) => {
    try {
      const emp = await getEmployee(ctx);
      const id = Number(ctx.match[1]);
      const row = await overtimeRepo.findById(id);
      if (!row || row.employee_id !== emp.id) {
        await ctx.answerCbQuery('❌ Catatan tidak ditemukan atau bukan milik Anda.').catch(() => {});
        return undefined;
      }
      const text = sessionDetailText(row);
      const markup = detailKeyboard(id, row.status);
      try {
        await ctx.editMessageText(text, markup);
      } catch (e) {
        ctx.reply(text, markup);
      }
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage || 'Gagal memuat detail.').catch(() => {});
      return undefined;
    }
  });

  // Navigasi halaman riwayat (juga dipakai tombol "Kembali ke Riwayat").
  bot.action(/^ed:page:(\d+)$/, async (ctx) => {
    try {
      const finished = await loadOwnHistory(ctx);
      if (!finished.length) {
        await ctx.answerCbQuery('Riwayat kosong.').catch(() => {});
        return undefined;
      }
      const page = Math.min(Math.max(0, Number(ctx.match[1]) || 0), historyPages(finished) - 1);
      await renderHistoryPage(ctx, finished, page, true);
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage || 'Gagal memuat riwayat.').catch(() => {});
      return undefined;
    }
  });

  bot.action(/^ed:noop$/, (ctx) => ctx.answerCbQuery().catch(() => {}));

  bot.command('history', history);
  bot.hears('📁 Riwayat Lembur', history);

  // ---- Wizard Edit: menu field, kalender, jam, istirahat, ringkasan, simpan ----
  const editMenuText = (st) => [
    `✏️ Edit catatan lembur #${st.sessionId}`,
    '',
    'Nilai saat ini:',
    `• Tanggal: ${formatDateId(st.data.date)}`,
    `• Mulai: ${hhmm(st.data.start)}`,
    `• Selesai: ${hhmm(st.data.end)}${st.data.crossMidnight ? ' (hari berikutnya)' : ''}`,
    `• Istirahat: ${formatDurationId(st.data.breakMinutes || 0)}`,
    '',
    'Pilih bagian yang ingin diubah. Durasi dihitung ulang otomatis dari tanggal & jam.',
    'Ketik /batal untuk membatalkan edit.',
  ].join('\n');

  const editMenuKeyboard = () => ({ reply_markup: { inline_keyboard: [
    [{ text: '📅 Tanggal', callback_data: 'ed:f:date' }],
    [{ text: '⏰ Jam Mulai', callback_data: 'ed:f:start' }],
    [{ text: '🏁 Jam Selesai', callback_data: 'ed:f:end' }],
    [{ text: '☕ Istirahat', callback_data: 'ed:f:brk' }],
    [{ text: '📋 Ringkasan & Simpan', callback_data: 'ed:review' }],
    [{ text: '◀️ Kembali ke Detail', callback_data: 'ed:back' }],
    [{ text: '❌ Batal', callback_data: 'ed:cancel' }],
  ] } });

  const showEditMenu = async (ctx, st) => {
    const text = editMenuText(st);
    try {
      await ctx.editMessageText(text, editMenuKeyboard());
    } catch (e) {
      ctx.reply(text, editMenuKeyboard());
    }
  };

  bot.action(/^ed:edit:(\d+)$/, async (ctx) => {
    try {
      const emp = await getEmployee(ctx);
      const id = Number(ctx.match[1]);
      const row = await overtimeRepo.findById(id);
      if (!row || row.employee_id !== emp.id) {
        await ctx.answerCbQuery('❌ Catatan tidak ditemukan atau bukan milik Anda.').catch(() => {});
        return undefined;
      }
      if (!OvertimeService.EDITABLE_STATUSES.includes(row.status)) {
        await ctx.answerCbQuery(`❌ Catatan berstatus "${statusLabel(row.status)}" tidak dapat diedit.`).catch(() => {});
        return undefined;
      }
      const s = localParts(new Date(row.start_at));
      const e = localParts(new Date(row.end_at));
      const crossMidnight = s.date !== e.date;
      const data = {
        date: s.ymd, start: { h: s.h, min: s.min },
        end: { h: e.h, min: e.min }, crossMidnight, breakMinutes: Number(row.break_minutes) || 0,
      };
      setEditState(ctx, 'menu', {
        sessionId: id, data,
        // Salinan mendalam: nilai lama TIDAK boleh berbagi referensi dengan draf.
        orig: { ...JSON.parse(JSON.stringify(data)), minutes: rowNetMinutes(row).gross, start_at: row.start_at, end_at: row.end_at },
      });
      await showEditMenu(ctx, getEditState(ctx));
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage || 'Gagal membuka edit.').catch(() => {});
      return undefined;
    }
  });

  bot.action(/^ed:cancel$/, async (ctx) => {
    const had = editWizard.delete(ctx.from.id);
    await ctx.answerCbQuery(had ? 'Edit dibatalkan.' : 'Tidak ada sesi edit.').catch(() => {});
    return ctx.reply(had ? '❌ Edit lembur dibatalkan. Tidak ada perubahan yang disimpan.' : 'Tidak ada sesi edit yang berjalan.');
  });

  const EDIT_EXPIRED_MSG = '❌ Sesi edit sudah berakhir atau kedaluwarsa. Buka kembali 📁 Riwayat Lembur.';

  bot.action(/^ed:menu$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(EDIT_EXPIRED_MSG).catch(() => {});
    setEditState(ctx, 'menu');
    await showEditMenu(ctx, getEditState(ctx));
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  bot.action(/^ed:f:date$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(EDIT_EXPIRED_MSG).catch(() => {});
    setEditState(ctx, 'date');
    const view = { y: st.data.date.y, m: st.data.date.m };
    const text = `📅 Pilih tanggal lembur baru (edit #${st.sessionId}) — tampilan ${formatDateId({ y: view.y, m: view.m, d: 1 }).replace(/^1 /, '')}\nKetik /batal untuk membatalkan edit.`;
    const markup = { reply_markup: { inline_keyboard: calendarKeyboard(view.y, view.m) } };
    try {
      await ctx.editMessageText(text, markup);
    } catch (e) {
      ctx.reply(text, markup);
    }
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  bot.action(/^ed:f:(start|end)$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(EDIT_EXPIRED_MSG).catch(() => {});
    const field = ctx.match[1];
    setEditState(ctx, field);
    const label = field === 'start' ? 'mulai' : 'selesai';
    ctx.reply(`✏️ Edit #${st.sessionId} — kirim jam ${label} baru dengan format HH:MM.\nNilai saat ini: ${hhmm(st.data[field])}\nContoh: ${field === 'start' ? '16:30' : '17:30'}. Atau /batal.`);
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  bot.action(/^ed:f:brk$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(EDIT_EXPIRED_MSG).catch(() => {});
    setEditState(ctx, 'brk');
    ctx.reply(
      `☕ Edit #${st.sessionId} — pilih durasi istirahat baru (durasi bersih = kotor − istirahat).\nNilai saat ini: ${formatDurationId(st.data.breakMinutes || 0)}.`,
      { reply_markup: { inline_keyboard: [
        [{ text: '☕ 0 menit', callback_data: 'ed:b:0' }],
        [{ text: '☕ 30 menit', callback_data: 'ed:b:30' }],
        [{ text: '☕ 45 menit', callback_data: 'ed:b:45' }],
        [{ text: '☕ 60 menit', callback_data: 'ed:b:60' }],
        [{ text: '✏️ Input manual (menit)', callback_data: 'ed:b:custom' }],
        [{ text: '◀️ Kembali', callback_data: 'ed:menu' }],
      ] } }
    );
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });
  bot.action(/^ed:b:(0|30|45|60|custom)$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st || st.step !== 'brk') {
      return ctx.answerCbQuery('❌ Pemilihan istirahat tidak valid untuk sesi edit ini.').catch(() => {});
    }
    const choice = ctx.match[1];
    if (choice === 'custom') {
      setEditState(ctx, 'brk_custom');
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply('✏️ Kirim jumlah menit istirahat sebagai bilangan bulat (harus kurang dari durasi kotor).\nContoh: 40. Atau /batal.');
    }
    st.data.breakMinutes = Number(choice);
    setEditState(ctx, 'menu');
    await showEditMenu(ctx, getEditState(ctx));
    await ctx.answerCbQuery(`Istirahat: ${choice} menit`).catch(() => {});
    return undefined;
  });

  bot.action(/^ed:back$/, async (ctx) => {
    // "Kembali ke detail": tampilkan ulang detail catatan (nilai tersimpan, bukan draf).
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(EDIT_EXPIRED_MSG).catch(() => {});
    const row = await overtimeRepo.findById(st.sessionId);
    if (!row || row.employee_id !== (await getEmployee(ctx)).id) {
      return ctx.answerCbQuery('❌ Catatan tidak ditemukan atau bukan milik Anda.').catch(() => {});
    }
    const text = sessionDetailText(row);
    const markup = detailKeyboard(st.sessionId, row.status);
    try {
      await ctx.editMessageText(text, markup);
    } catch (e) {
      ctx.reply(text, markup);
    }
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  /** Hitung ulang periode dari draf edit; melempar ValidationError bila tidak valid. */
  function recomputeEditPeriod(st) {
    const d = st.data;
    return resolvePeriod(d.date, d.start, d.end, { crossMidnight: !!d.crossMidnight, timezone: tz });
  }

  const buildEditSummary = (st, minutes, overlapping) => {
    const o = st.orig; const d = st.data;
    const oldBrk = o.breakMinutes || 0;
    const newBrk = d.breakMinutes || 0;
    const line = (label, oldV, newV) => (oldV === newV
      ? `• ${label}: ${oldV}`
      : `• ${label}: ${oldV} → ${newV}`);
    const lines = [
      `📋 Ringkasan perubahan — catatan #${st.sessionId}`,
      line('Tanggal', formatDateId(o.date), formatDateId(d.date)),
      line('Mulai', hhmm(o.start), hhmm(d.start)),
      line('Selesai', hhmm(o.end) + (o.crossMidnight ? ' (hari berikutnya)' : ''),
        hhmm(d.end) + (d.crossMidnight ? ' (hari berikutnya)' : '')),
      line('Istirahat', formatDurationId(oldBrk), formatDurationId(newBrk)),
      line('Durasi kotor', formatDurationId(o.minutes), formatDurationId(minutes)),
      line('Durasi bersih', formatDurationId(o.minutes - oldBrk), formatDurationId(minutes - newBrk)),
    ];
    if (overlapping && overlapping.length) {
      lines.push('', `⚠️ PERINGATAN: periode hasil edit TUMPANG TINDIH dengan ${overlapping.length} catatan lain yang sudah ada:`
        + '\n' + overlapping.map((r) => `  - ${formatInTz(new Date(r.start_at), tz)} → ${formatInTz(new Date(r.end_at), tz)}`).join('\n'));
    }
    lines.push('', 'Klik "💾 Simpan" untuk menyimpan perubahan.');
    return lines.join('\n');
  };

  bot.command('input', startInput);

  const reviewKeyboard = () => ({ reply_markup: { inline_keyboard: [
    [{ text: '💾 Simpan', callback_data: 'ed:save' }],
    [{ text: '◀️ Kembali ke Detail', callback_data: 'ed:back' }],
    [{ text: '❌ Batal', callback_data: 'ed:cancel' }],
  ] } });

  bot.action(/^ed:review$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(EDIT_EXPIRED_MSG).catch(() => {});
    try {
      const emp = await getEmployee(ctx);
      const period = recomputeEditPeriod(st);
      st.data.minutes = period.minutes;
      const newBrk = st.data.breakMinutes || 0;
      if (newBrk >= period.minutes) {
        await ctx.answerCbQuery(`❌ Istirahat ${newBrk} menit ≥ durasi kotor ${period.minutes} menit — durasi bersih tidak boleh 0 atau negatif.`).catch(() => {});
        return undefined;
      }
      // Cek duplikat & tumpang tindih (diri sendiri dikecualikan) — informasional;
      // validasi final tetap dijalankan service saat ed:save.
      const dayStart = zonedWallToUtc(st.data.date.y, st.data.date.m, st.data.date.d, 0, 0, tz);
      const existing = await overtimeRepo.listByEmployeeAndWindow(
        emp.id,
        new Date(dayStart.getTime() - 12 * 3600 * 1000),
        new Date(dayStart.getTime() + 36 * 3600 * 1000)
      );
      const dup = existing.find((r) => r.id !== st.sessionId && r.end_at
        && new Date(r.start_at).getTime() === period.startUtc.getTime()
        && new Date(r.end_at).getTime() === period.endUtc.getTime()
        && r.status !== 'rejected');
      if (dup) {
        await ctx.answerCbQuery('❌ Periode identik (mulai & selesai sama) sudah tercatat pada catatan lain.').catch(() => {});
        return undefined;
      }
      const overlapping = existing.filter((r) => r.id !== st.sessionId && r.status !== 'rejected' && r.end_at
        && periodsOverlap(new Date(r.start_at), new Date(r.end_at), period.startUtc, period.endUtc));
      setEditState(ctx, 'review', { overlapping });
      const text = buildEditSummary(st, period.minutes, overlapping);
      await ctx.reply(text, reviewKeyboard());
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.userMessage || err.message}`).catch(() => {});
      return undefined;
    }
  });

  bot.action(/^ed:save$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st || st.step !== 'review') {
      return ctx.answerCbQuery('❌ Sesi edit tidak valid. Buka "📋 Ringkasan & Simpan" lagi dari menu Edit.').catch(() => {});
    }
    try {
      const emp = await getEmployee(ctx);
      const result = await overtimeService.updateManualPeriod(emp, st.sessionId, {
        date: st.data.date, start: st.data.start, end: st.data.end,
        crossMidnight: st.data.crossMidnight, breakMinutes: st.data.breakMinutes || 0,
      }, { force: true });
      editWizard.delete(ctx.from.id);
      ctx.reply([
        `✅ Perubahan catatan #${st.sessionId} tersimpan.`,
        `• Tanggal: ${formatDateId(st.data.date)}`,
        `• Mulai: ${hhmm(st.data.start)} — Selesai: ${hhmm(st.data.end)}${st.data.crossMidnight ? ' (hari berikutnya)' : ''}`,
        `• Durasi kotor: ${formatDurationId(result.grossMinutes)}`,
        `• Istirahat: ${formatDurationId(result.breakMinutes)}`,
        `• Durasi bersih: ${formatDurationId(result.actualMinutes)}`,
        `• Total lembur harian (semua periode, bersih): ${formatDurationId(result.dayTotalMinutes)}`,
      ].join('\n'));
      return undefined;
    } catch (err) {
      return ctx.reply(`❌ Gagal menyimpan perubahan: ${err.userMessage || err.message || 'kesalahan internal'}\nBuka 📁 Riwayat Lembur untuk mencoba lagi.`);
    }
  });

  bot.hears('📝 INPUT LEMBUR', startInput);

  // ---- Navigasi rekap bulanan (callback dari keyboard "Status Lembur Saya") ----
  bot.action(/^pay:(\d{4})-(\d{2})$/, async (ctx) => {
    try {
      const y = Number(ctx.match[1]);
      const m = Number(ctx.match[2]);
      if (y < 2000 || y > 2100 || m < 1 || m > 12) {
        await ctx.answerCbQuery('Bulan tidak valid.').catch(() => {});
        return undefined;
      }
      const emp = employeeService
        ? await employeeService.requireActiveEmployee(ctx.from.id)
        : requireActive(ctx);
      const monthly = await overtimeService.getMonthlyPayroll(emp, y, m);
      const nowP = toZonedParts(new Date(), tz);
      const [curY, curM] = nowP.date.split('-').map(Number);
      const replyMarkup = { reply_markup: { inline_keyboard: navKeyboard(y, m, curY, curM) } };
      try {
        await ctx.editMessageText(monthly.text, replyMarkup);
      } catch (e) {
        ctx.reply(monthly.text, replyMarkup);
      }
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage || 'Gagal memuat rekap.').catch(() => {});
      return undefined;
    }
  });

  // ---- Ekspor Excel rekap bulanan (callback dari tombol "📥 Export Excel") ----
  bot.action(/^exp:(\d{4})-(\d{2})$/, async (ctx) => {
    const parsed = parseMonthParam(`${ctx.match[1]}-${ctx.match[2]}`);
    if (!parsed) {
      await ctx.answerCbQuery('Bulan tidak valid.').catch(() => {});
      return undefined;
    }
    let emp;
    try {
      emp = employeeService
        ? await employeeService.requireActiveEmployee(ctx.from.id)
        : requireActive(ctx);
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage || 'Akun tidak aktif.').catch(() => {});
      return undefined;
    }
    await ctx.answerCbQuery('Membuat file Excel...').catch(() => {});
    try {
      const { buffer, filename } = await overtimeService.exportMonthlyPayroll(emp, parsed.y, parsed.m);
      await ctx.replyWithDocument({ source: buffer, filename });
      return undefined;
    } catch (err) {
      // Jangan klaim file terkirim; laporkan kegagalan tanpa detail internal.
      await ctx.answerCbQuery('Gagal membuat atau mengirim file.').catch(() => {});
      return undefined;
    }
  });
}

module.exports = { registerOvertimeHandlers };
