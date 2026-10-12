'use strict';
const { requireActive } = require('../middleware/auth');
const {
  parseTimeHHMM, resolvePeriod, formatDurationId, formatDailyRecap, periodsOverlap, rowNetMinutes,
} = require('../../services/overtime-input');
const { formatInTz, toZonedParts, zonedWallToUtc } = require('../../utils/date-time');
const { navKeyboard, parseMonthParam } = require('../../services/payroll');
const { todayInTz, parseCalDate, formatDateId, calendarKeyboard } = require('../../services/calendar');
const { OvertimeService } = require('../../services/overtime.service');
const { LABELS } = require('../keyboards');
const i18n = require('../../i18n');

const WIZARD_TTL_MS = 15 * 60 * 1000;
const HISTORY_PER_PAGE = 5;

/** bot.hears untuk label dalam SEMUA bahasa (label lama tetap dikenali). */
function hearsAllLanguages(bot, labels, handler) {
  const escaped = labels.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  bot.hears(new RegExp(`^(?:${escaped.join('|')})$`), handler);
}

function registerOvertimeHandlers(bot, services) {
  const { overtimeService, employeeService, config, overtimeRepo } = services;
  const tz = config.timezone;

  /** Bahasa pengguna dari state (middleware auth); fallback 'id'. */
  const L = (ctx) => i18n.normalizeLang(ctx.state && ctx.state.employee && ctx.state.employee.language);
  const T = (ctx) => (key, params) => i18n.t(L(ctx), key, params);
  const E = (ctx, msg) => i18n.trError(L(ctx), msg); // terjemahkan pesan error service

  // Jawaban ya/tidak dalam bahasa pengguna (kompatibel: 'ya'/'tidak' selalu diterima).
  const YES_WORDS = ['ya', 'yes', '是', 'có'];
  const NO_WORDS = ['tidak', 'no', '否', 'không'];
  const isYes = (lower) => YES_WORDS.includes(lower);
  const isNo = (lower) => NO_WORDS.includes(lower);

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

  /** Bagian tanggal/jam lokal dari instan UTC: {date:'YYYY-MM-DD', ymd:{y,m,d}, h, min}. */
  const localParts = (date) => {
    const p = toZonedParts(date, tz);
    return { date: p.date, ymd: p.ymd, h: Number(p.time.slice(0, 2)), min: Number(p.time.slice(3, 5)) };
  };

  /** Ambil employee untuk callback (service-based bila tersedia, else middleware). */
  const getEmployee = async (ctx) => (employeeService
    ? employeeService.requireActiveEmployee(ctx.from.id)
    : requireActive(ctx));

  // Keyboard kecil untuk mengganti tanggal setelah tanggal terpilih.
  const dateChangeKeyboard = (ctx) => ({
    reply_markup: {
      inline_keyboard: [
        [{ text: T(ctx)('ov.pickOtherDate'), callback_data: 'cal:open' }],
        [{ text: T(ctx)('common.cancel'), callback_data: 'cal:cancel' }],
      ],
    },
  });

  const promptStart = (ctx, data) => {
    const tr = T(ctx);
    return `${tr('ov.inputTitle')}\n\n`
      + `${tr('ov.selectedDate', { date: formatDateId(data.date, L(ctx)) })}\n\n`
      + `${tr('ov.step2')}\n\n`
      + `${tr('ov.wrongDate')}\n`
      + `${tr('common.cancelHint')}`;
  };

  const startInput = async (ctx) => {
    try {
      requireActive(ctx);
      // Tanggal hari ini menurut zona waktu aplikasi (bukan timezone server).
      const date = todayInTz(tz);
      setState(ctx, 'start', { date });
      ctx.reply(promptStart(ctx, { date }), dateChangeKeyboard(ctx));
    } catch (err) {
      ctx.reply(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('ov.failStart'));
    }
  };

  const cancelInput = async (ctx) => {
    const had = wizard.delete(ctx.from.id) | editWizard.delete(ctx.from.id);
    ctx.reply(had ? T(ctx)('ov.cancelled') : T(ctx)('ov.noSession'));
  };

  /** Ringkasan periode sebelum konfirmasi (kotor / istirahat / bersih). */
  function buildSummary(ctx, data, crossMidnight, overlapping) {
    const lang = L(ctx);
    const tr = T(ctx);
    const gross = data.minutes;
    const brk = data.breakMinutes || 0;
    const lines = [
      tr('ov.summaryTitle'),
      tr('ov.summaryDate', { date: formatDateId(data.date, lang) }),
      tr('ov.summaryStart', { time: `${String(data.start.h).padStart(2, '0')}:${String(data.start.min).padStart(2, '0')}` }),
      tr('ov.summaryEnd', { time: `${String(data.end.h).padStart(2, '0')}:${String(data.end.min).padStart(2, '0')}` })
        + (crossMidnight ? i18n.t(lang, 'common.crossMidnightTag') : ''),
      tr('ov.summaryGross', { duration: formatDurationId(gross, lang) }),
      tr('ov.summaryBreak', { duration: formatDurationId(brk, lang) }),
      tr('ov.summaryNet', { duration: formatDurationId(gross - brk, lang) }),
    ];
    if (overlapping && overlapping.length) {
      lines.push('', tr('ov.overlapWarning', { count: overlapping.length })
        + '\n' + overlapping.map((r) => `  - ${formatInTz(new Date(r.start_at), tz)} → ${formatInTz(new Date(r.end_at), tz)}`).join('\n'));
    }
    lines.push('', tr('ov.confirmPrompt'));
    return lines.join('\n');
  }

  /** Keyboard pilihan durasi istirahat (default 0 menit — tidak pernah dipotong otomatis). */
  const breakKeyboard = (ctx) => {
    const tr = T(ctx);
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: tr('ov.breakNone'), callback_data: 'brk:0' }],
          [{ text: tr('ov.break30'), callback_data: 'brk:30' }],
          [{ text: tr('ov.break45'), callback_data: 'brk:45' }],
          [{ text: tr('ov.break60'), callback_data: 'brk:60' }],
          [{ text: tr('ov.breakCustom'), callback_data: 'brk:custom' }],
          [{ text: tr('common.cancel'), callback_data: 'brk:cancel' }],
        ],
      },
    };
  };

  /** Keyboard konfirmasi simpan (callback stabil cnf:yes|no; teks ya/tidak tetap didukung). */
  const confirmKeyboard = (ctx) => {
    const tr = T(ctx);
    return { reply_markup: { inline_keyboard: [[
      { text: tr('confirm.yesBtn'), callback_data: 'cnf:yes' },
      { text: tr('confirm.noBtn'), callback_data: 'cnf:no' },
    ]] } };
  };

  /** Setelah jam selesai valid: tampilkan durasi kotor + pilihan istirahat. */
  function promptBreak(ctx, data) {
    setState(ctx, 'break', data);
    return ctx.reply(
      `${T(ctx)('ov.grossDuration', { duration: formatDurationId(data.minutes, L(ctx)) })}\n\n`
      + T(ctx)('ov.breakPrompt'),
      breakKeyboard(ctx)
    );
  }

  /** Setelah lintas-hari dikonfirmasi/ditolak: hitung durasi kotor, lanjut ke istirahat. */
  function proceedAfterCross(ctx, data, crossMidnight) {
    let period;
    try {
      period = resolvePeriod(data.date, data.start, data.end, { crossMidnight, timezone: tz });
    } catch (err) {
      setState(ctx, 'end', data);
      return ctx.reply(`❌ ${E(ctx, err.message)}\n${T(ctx)('ov.resendTimeShort')}`);
    }
    data.crossMidnight = crossMidnight;
    data.minutes = period.minutes;
    return promptBreak(ctx, data);
  }

  /** Validasi akhir: duplikat, tumpang tindih → minta konfirmasi (data.breakMinutes sudah dipilih). */
  async function evaluatePeriod(ctx, emp, data) {
    const lang = L(ctx);
    const crossMidnight = !!data.crossMidnight;
    let period;
    try {
      period = resolvePeriod(data.date, data.start, data.end, { crossMidnight, timezone: tz });
    } catch (err) {
      wizard.delete(ctx.from.id);
      return ctx.reply(T(ctx)('ov.periodInvalid', { reason: E(ctx, err.message) }));
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
      return ctx.reply(`❌ ${T(ctx)('err.dupPeriod')}`);
    }
    const overlapping = existing.filter((r) => r.status !== 'rejected' && r.end_at
      && periodsOverlap(new Date(r.start_at), new Date(r.end_at), period.startUtc, period.endUtc));

    setState(ctx, 'confirm', data);
    ctx.reply(buildSummary(ctx, data, crossMidnight, overlapping), confirmKeyboard(ctx));
  }

  async function saveConfirmed(ctx, emp, data) {
    const lang = L(ctx);
    const tr = T(ctx);
    try {
      const result = await overtimeService.createManualPeriod(emp, {
        date: data.date, start: data.start, end: data.end, crossMidnight: data.crossMidnight,
        breakMinutes: data.breakMinutes || 0,
      }, { force: true });
      const lines = [
        tr('ov.saved'),
        tr('ov.summaryDate', { date: formatDateId(data.date, lang) }),
        tr('ov.savedStartEnd', {
          start: `${String(data.start.h).padStart(2, '0')}:${String(data.start.min).padStart(2, '0')}`,
          end: `${String(data.end.h).padStart(2, '0')}:${String(data.end.min).padStart(2, '0')}`,
        }),
        tr('ov.summaryGross', { duration: formatDurationId(result.grossMinutes, lang) }),
        tr('ov.summaryBreak', { duration: formatDurationId(result.breakMinutes, lang) }),
        tr('ov.summaryNet', { duration: formatDurationId(result.actualMinutes, lang) }),
        tr('ov.savedDayTotal', { duration: formatDurationId(result.dayTotalMinutes, lang) }),
        '',
        tr('ov.savedHint'),
      ];
      wizard.delete(ctx.from.id);
      ctx.reply(lines.join('\n'));
    } catch (err) {
      // Jangan hapus state wizard agar pengguna bisa mencoba konfirmasi lagi.
      ctx.reply(tr('ov.saveFailed', { reason: err.userMessage ? E(ctx, err.userMessage) : (err.message || '') }));
    }
  }

  /** Router teks untuk wizard edit (langkah jam mulai/selesai, lintas hari, istirahat manual). */
  async function handleEditText(ctx, ed) {
    const lang = L(ctx);
    const tr = T(ctx);
    const text = (ctx.message && ctx.message.text ? ctx.message.text : '').trim();
    const lower = text.toLowerCase();
    if (lower === '/batal' || lower === 'batal') {
      editWizard.delete(ctx.from.id);
      return ctx.reply(tr('edit.cancelled'));
    }
    if (ed.step === 'start' || ed.step === 'end') {
      let t;
      try { t = parseTimeHHMM(text); } catch (err) {
        return ctx.reply(`❌ ${E(ctx, err.message)}\n${tr('ov.timeInvalidRetry')}`);
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
          return ctx.reply(tr('ov.crossMidnightAsk'));
        }
        return ctx.reply(`❌ ${E(ctx, err.message)}\n${tr('ov.resendTime')}`);
      }
    }
    if (ed.step === 'cross') {
      if (isYes(lower) || isNo(lower)) {
        ed.data.crossMidnight = isYes(lower);
        try {
          const period = resolvePeriod(ed.data.date, ed.data.start, ed.data.end, { crossMidnight: ed.data.crossMidnight, timezone: tz });
          ed.data.minutes = period.minutes;
          setEditState(ctx, 'menu', { data: ed.data });
          return showEditMenu(ctx, getEditState(ctx));
        } catch (err) {
          setEditState(ctx, 'end', { data: ed.data });
          return ctx.reply(`❌ ${E(ctx, err.message)}\n${tr('ov.resendTimeShort')}`);
        }
      }
      return ctx.reply(tr('ov.crossMidnightReask'));
    }
    if (ed.step === 'brk_custom') {
      const m = /^\d{1,4}$/.exec(text);
      if (!m) {
        return ctx.reply(tr('ov.breakInvalidGeneric'));
      }
      const minutes = Number(m[0]);
      let gross = ed.data.minutes;
      if (!Number.isInteger(gross)) {
        try { gross = recomputeEditPeriod(ed).minutes; } catch (err) { gross = null; }
      }
      if (gross === null || minutes >= gross) {
        return ctx.reply(tr('edit.brkExceedsEdit', {
          minutes,
          gross: gross ? i18n.t(lang, 'edit.brkExceedsGrossSuffix', { minutes: gross }) : '',
        }));
      }
      ed.data.breakMinutes = minutes;
      setEditState(ctx, 'menu', { data: ed.data });
      return showEditMenu(ctx, getEditState(ctx));
    }
    if (ed.step === 'menu' || ed.step === 'brk' || ed.step === 'date' || ed.step === 'review') {
      return ctx.reply(tr('edit.useButtons'));
    }
    editWizard.delete(ctx.from.id);
    return ctx.reply(tr('edit.flowUnknown'));
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
    const lang = L(ctx);
    const tr = T(ctx);
    const text = (ctx.message.text || '').trim();
    const lower = text.toLowerCase();

    if (st.step === 'cross' && (isYes(lower) || isNo(lower))) {
      if (isYes(lower)) return proceedAfterCross(ctx, st.data, true);
      setState(ctx, 'end', st.data);
      return ctx.reply(tr('ov.sameDayAnswer'));
    }
    if (st.step === 'confirm') {
      if (isYes(lower)) return saveConfirmed(ctx, emp, st.data);
      if (isNo(lower)) { wizard.delete(ctx.from.id); return ctx.reply(tr('ov.cancelled')); }
      return ctx.reply(tr('ov.confirmReask'));
    }
    if (st.step === 'start') {
      try { st.data.start = parseTimeHHMM(text); } catch (err) {
        return ctx.reply(`❌ ${E(ctx, err.message)}\n${tr('ov.timeInvalidRetry')}`);
      }
      setState(ctx, 'end', st.data);
      return ctx.reply(tr('ov.step3'));
    }
    if (st.step === 'end') {
      try { st.data.end = parseTimeHHMM(text); } catch (err) {
        return ctx.reply(`❌ ${E(ctx, err.message)}\n${tr('ov.timeInvalidRetry')}`);
      }
      let period;
      try {
        period = resolvePeriod(st.data.date, st.data.start, st.data.end, { crossMidnight: false, timezone: tz });
      } catch (err) {
        if (err.code === 'CROSS_MIDNIGHT') {
          setState(ctx, 'cross', st.data);
          return ctx.reply(tr('ov.crossMidnightAsk'));
        }
        return ctx.reply(`❌ ${E(ctx, err.message)}\n${tr('ov.resendTime')}`);
      }
      st.data.minutes = period.minutes;
      return promptBreak(ctx, st.data);
    }
    if (st.step === 'break_custom') {
      const m = /^\d{1,4}$/.exec(text);
      if (!m) {
        return ctx.reply(tr('ov.breakInvalidRange', { min: 0, max: Math.max(0, st.data.minutes - 1) }));
      }
      const minutes = Number(m[0]);
      const err = applyBreakChoice(ctx, st.data, minutes);
      if (err) return ctx.reply(`❌ ${E(ctx, err)}\n${tr('ov.timeInvalidRetry')}`);
      return undefined;
    }
    if (st.step === 'break') {
      return ctx.reply(tr('ov.breakUseButtons'));
    }
    if (lower === '/batal' || lower === 'batal') return cancelInput(ctx);
    wizard.delete(ctx.from.id);
    return ctx.reply(tr('ov.flowUnknown'));
  });

  // ---- Pilihan durasi istirahat (callback "brk:") ----
  // Terikat pada wizard ctx.from.id; hanya valid di langkah pemilihan istirahat.
  function getWizardForBreak(ctx) {
    const tr = T(ctx);
    const st = getState(ctx);
    if (!st) return { err: tr('ov.sessionExpired') };
    if (st.step !== 'break' && st.step !== 'break_custom') {
      return { err: tr('ov.breakDone') };
    }
    return { st };
  }

  /** Terapkan pilihan istirahat; kembalikan pesan error (string) jika tidak valid. */
  function applyBreakChoice(ctx, data, minutes) {
    if (!Number.isInteger(minutes) || minutes < 0) return T(ctx)('ov.dateInvalid');
    if (minutes >= data.minutes) {
      return T(ctx)('edit.brkExceedsToast', { minutes, gross: data.minutes });
    }
    data.breakMinutes = minutes;
    setState(ctx, 'confirm', data);
    evaluatePeriod(ctx, requireActive(ctx), data)
      .catch(() => { wizard.delete(ctx.from.id); ctx.reply(T(ctx)('ov.failProcess')); });
    return null;
  }

  bot.action(/^brk:(0|30|45|60|custom|cancel)$/, async (ctx) => {
    const tr = T(ctx);
    const g = getWizardForBreak(ctx);
    if (g.err) {
      await ctx.answerCbQuery(`❌ ${g.err}`).catch(() => {});
      return undefined;
    }
    const choice = ctx.match[1];
    if (choice === 'cancel') {
      wizard.delete(ctx.from.id);
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(tr('ov.cancelled'));
    }
    if (choice === 'custom') {
      setState(ctx, 'break_custom', g.st.data);
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(tr('ov.breakCustomPrompt', { min: 0, max: Math.max(0, g.st.data.minutes - 1) }));
    }
    const err = applyBreakChoice(ctx, g.st.data, Number(choice));
    await ctx.answerCbQuery().catch(() => {});
    if (err) return ctx.reply(`❌ ${err}`);
    return undefined;
  });

  bot.command('batal', cancelInput);
  bot.hears('❌ Batalkan Input', cancelInput);

  // ---- Kalender interaktif: pemilihan tanggal input lembur (callback "cal:") ----

  /** Wizard input ATAU edit aktif & berada di langkah pemilihan tanggal? */
  function getWizardForCalendar(ctx) {
    const tr = T(ctx);
    const st = getState(ctx);
    if (st && st.step === 'start') return { kind: 'input', st };
    const ed = getEditState(ctx);
    if (ed && ed.step === 'date') return { kind: 'edit', st: ed };
    if (st) return { err: tr('ov.calDoneInput') };
    if (ed) return { err: tr('ov.calDoneEdit') };
    return { err: tr('ov.calExpired') };
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
    const lang = L(ctx);
    const view = { y: g.st.data.date.y, m: g.st.data.date.m };
    const monthLabel = i18n.t(lang, 'ov.calTitle', {
      month: `${i18n.monthName(lang, view.m)} ${view.y}`,
    });
    try {
      await ctx.editMessageText(
        `${monthLabel}\n${T(ctx)('ov.calCancelledHint')}`,
        { reply_markup: { inline_keyboard: calendarKeyboard(view.y, view.m, lang) } }
      );
    } catch (e) {
      ctx.reply(T(ctx)('ov.calTitlePlain'), { reply_markup: { inline_keyboard: calendarKeyboard(view.y, view.m, lang) } });
    }
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  // Navigasi bulan: callback membawa bulan target yang sudah dihitung keyboard
  // (termasuk rollover antar tahun, mis. Des 2026 → cal:next:2027-01).
  bot.action(/^cal:(prev|next):(\d{4})-(\d{2})$/, async (ctx) => {
    const g = await calGuard(ctx);
    if (!g) return undefined;
    const lang = L(ctx);
    const y = Number(ctx.match[2]);
    const m = Number(ctx.match[3]);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) {
      await ctx.answerCbQuery(T(ctx)('ov.monthInvalid')).catch(() => {});
      return undefined;
    }
    const monthLabel = i18n.t(lang, 'ov.calTitle', { month: `${i18n.monthName(lang, m)} ${y}` });
    try {
      await ctx.editMessageText(
        `${monthLabel}\n${T(ctx)('ov.calCancelledHint')}`,
        { reply_markup: { inline_keyboard: calendarKeyboard(y, m, lang) } }
      );
    } catch (e) {
      ctx.reply(`${i18n.t(lang, 'ov.calTitlePlain')}`,
        { reply_markup: { inline_keyboard: calendarKeyboard(y, m, lang) } });
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
      await ctx.answerCbQuery(T(ctx)('ov.dateInvalid')).catch(() => {});
      return undefined;
    }
    const lang = L(ctx);
    const st = g.st;
    st.data.date = date;
    if (g.kind === 'edit') {
      setEditState(ctx, 'menu', { data: st.data });
      await showEditMenu(ctx, getEditState(ctx));
      await ctx.answerCbQuery(T(ctx)('ov.calPickConfirm', { date: formatDateId(date, lang) })).catch(() => {});
      return undefined;
    }
    setState(ctx, 'start', st.data);
    try {
      await ctx.editMessageText(promptStart(ctx, st.data), dateChangeKeyboard(ctx));
    } catch (e) {
      ctx.reply(promptStart(ctx, st.data), dateChangeKeyboard(ctx));
    }
    await ctx.answerCbQuery(T(ctx)('ov.calPickConfirm', { date: formatDateId(date, lang) })).catch(() => {});
    return undefined;
  };

  bot.action(/^cal:sel:(\d{4})-(\d{2})-(\d{2})$/, (ctx) => pickDate(parseCalDate(`${ctx.match[1]}-${ctx.match[2]}-${ctx.match[3]}`))(ctx));
  bot.action(/^cal:today$/, (ctx) => pickDate(todayInTz(tz))(ctx));

  // Batal lewat tombol kalender (input maupun edit).
  bot.action(/^cal:cancel$/, async (ctx) => {
    const had = wizard.delete(ctx.from.id) | editWizard.delete(ctx.from.id);
    const text = T(ctx)('ov.cancelled');
    try {
      await ctx.editMessageText(text);
    } catch (e) {
      ctx.reply(text);
    }
    await ctx.answerCbQuery(had ? T(ctx)('ov.cancelledToast') : T(ctx)('ov.noSessionToast')).catch(() => {});
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

  const historyPageKeyboard = (ctx, finished, page) => {
    const lang = L(ctx);
    const tr = T(ctx);
    const pages = historyPages(finished);
    const p = Math.min(Math.max(0, page), pages - 1);
    const slice = finished.slice(p * HISTORY_PER_PAGE, p * HISTORY_PER_PAGE + HISTORY_PER_PAGE);
    const kb = slice.map((r) => {
      const { net } = rowNetMinutes(r);
      const s = localParts(new Date(r.start_at));
      const e = localParts(new Date(r.end_at));
      const tag = r.status === 'pending' ? i18n.t(lang, 'common.oldDataTag') : '';
      return [{
        text: `${formatDateId(s.ymd, lang)} ${hhmm(s)}–${hhmm(e)} · ${formatDurationId(net, lang)}${tag}`,
        callback_data: `ed:view:${r.id}`,
      }];
    });
    const nav = [];
    if (p > 0) nav.push({ text: tr('common.prevPage'), callback_data: `ed:page:${p - 1}` });
    nav.push({ text: tr('common.page', { page: p + 1, pages }), callback_data: 'ed:noop' });
    if (p < pages - 1) nav.push({ text: tr('common.nextPage'), callback_data: `ed:page:${p + 1}` });
    kb.push(nav);
    // Tombol ekspor riwayat (pemilih periode, callback stabil hexp:).
    kb.push([{ text: tr('hist.exportBtn'), callback_data: 'hexp:open' }]);
    return { page: p, keyboard: kb };
  };

  const historyPageText = (ctx, finished, page) => {
    const lang = L(ctx);
    const tr = T(ctx);
    const p = Math.min(Math.max(0, page), historyPages(finished) - 1);
    const slice = finished.slice(p * HISTORY_PER_PAGE, p * HISTORY_PER_PAGE + HISTORY_PER_PAGE);
    const groups = new Map();
    for (const r of slice) {
      const key = toZonedParts(new Date(r.start_at), tz).date;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const parts = [tr('hist.title'), '', tr('hist.tapHint')];
    for (const groupRows of groups.values()) {
      const recap = formatDailyRecap(groupRows, tz, null, lang);
      if (recap) parts.push('', recap);
    }
    return parts.join('\n');
  };

  const renderHistoryPage = (ctx, finished, page, edit = false) => {
    const { page: p, keyboard } = historyPageKeyboard(ctx, finished, page);
    const text = historyPageText(ctx, finished, p);
    const markup = { reply_markup: { inline_keyboard: keyboard } };
    if (edit) {
      return ctx.editMessageText(text, markup).catch(() => ctx.reply(text, markup));
    }
    return ctx.reply(text, markup);
  };

  const history = async (ctx) => {
    const lang = L(ctx);
    try {
      const finished = await loadOwnHistory(ctx);
      if (!finished.length) return ctx.reply(T(ctx)('hist.empty'));
      return renderHistoryPage(ctx, finished, 0);
    } catch (err) {
      return ctx.reply(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('hist.fail'));
    }
  };

  // ---- Detail catatan + tombol Edit (callback "ed:view") ----
  const statusLabel = (ctx, s) => {
    const lang = L(ctx);
    const map = {
      completed: 'detail.statusCompleted', pending: 'detail.statusPending',
      approved: 'detail.statusApproved', rejected: 'detail.statusRejected', active: 'detail.statusActive',
    };
    return map[s] ? i18n.t(lang, map[s]) : s;
  };

  const sessionDetailText = (ctx, row) => {
    const lang = L(ctx);
    const tr = T(ctx);
    const { gross, breakMinutes, net } = rowNetMinutes(row);
    const s = localParts(new Date(row.start_at));
    const e = localParts(new Date(row.end_at));
    const editable = OvertimeService.EDITABLE_STATUSES.includes(row.status);
    return [
      tr('detail.title', { id: row.id }),
      tr('detail.status', { status: statusLabel(ctx, row.status) }),
      tr('detail.date', { date: formatDateId(s.ymd, lang) }),
      tr('detail.start', { time: hhmm(s) }),
      tr('detail.end', { time: hhmm(e) }) + (s.date !== e.date ? i18n.t(lang, 'common.crossMidnightTag') : ''),
      tr('detail.gross', { duration: formatDurationId(gross, lang) }),
      tr('detail.break', { duration: formatDurationId(breakMinutes, lang) }),
      tr('detail.net', { duration: formatDurationId(net, lang) }),
      editable ? '' : tr('detail.notEditable'),
    ].filter((l) => l !== '').join('\n');
  };

  const detailKeyboard = (ctx, id, status) => ({ reply_markup: { inline_keyboard: [
    ...(OvertimeService.EDITABLE_STATUSES.includes(status)
      ? [[{ text: T(ctx)('detail.editButton'), callback_data: `ed:edit:${id}` }]]
      : []),
    [{ text: T(ctx)('detail.backToHistory'), callback_data: 'ed:page:0' }],
  ] } });

  bot.action(/^ed:view:(\d+)$/, async (ctx) => {
    try {
      const emp = await getEmployee(ctx);
      const id = Number(ctx.match[1]);
      const row = await overtimeRepo.findById(id);
      if (!row || row.employee_id !== emp.id) {
        await ctx.answerCbQuery(T(ctx)('detail.notFoundToast')).catch(() => {});
        return undefined;
      }
      const text = sessionDetailText(ctx, row);
      const markup = detailKeyboard(ctx, id, row.status);
      try {
        await ctx.editMessageText(text, markup);
      } catch (e) {
        ctx.reply(text, markup);
      }
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('detail.failLoadToast')).catch(() => {});
      return undefined;
    }
  });

  // Navigasi halaman riwayat (juga dipakai tombol "Kembali ke Riwayat").
  bot.action(/^ed:page:(\d+)$/, async (ctx) => {
    try {
      const finished = await loadOwnHistory(ctx);
      if (!finished.length) {
        await ctx.answerCbQuery(T(ctx)('hist.emptyToast')).catch(() => {});
        return undefined;
      }
      const page = Math.min(Math.max(0, Number(ctx.match[1]) || 0), historyPages(finished) - 1);
      await renderHistoryPage(ctx, finished, page, true);
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('hist.failToast')).catch(() => {});
      return undefined;
    }
  });

  bot.action(/^ed:noop$/, (ctx) => ctx.answerCbQuery().catch(() => {}));

  bot.command('history', history);
  // Label lama (string persis, kompatibel) + regex seluruh bahasa (handler pertama yang cocok menang).
  bot.hears('📁 Riwayat Lembur', history);
  hearsAllLanguages(bot, Object.values(LABELS.history), history);

  // ---- Wizard Edit: menu field, kalender, jam, istirahat, ringkasan, simpan ----
  const editMenuText = (ctx, st) => {
    const lang = L(ctx);
    const tr = T(ctx);
    return [
      tr('edit.title', { id: st.sessionId }),
      '',
      tr('edit.currentValues'),
      tr('edit.fieldDate', { value: formatDateId(st.data.date, lang) }),
      tr('edit.fieldStart', { value: hhmm(st.data.start) }),
      tr('edit.fieldEnd', { value: hhmm(st.data.end) }) + (st.data.crossMidnight ? i18n.t(lang, 'common.crossMidnightTag') : ''),
      tr('edit.fieldBreak', { value: formatDurationId(st.data.breakMinutes || 0, lang) }),
      '',
      tr('edit.pickField'),
      tr('edit.cancelHint'),
    ].join('\n');
  };

  const editMenuKeyboard = (ctx) => {
    const tr = T(ctx);
    return { reply_markup: { inline_keyboard: [
      [{ text: tr('edit.btnDate'), callback_data: 'ed:f:date' }],
      [{ text: tr('edit.btnStart'), callback_data: 'ed:f:start' }],
      [{ text: tr('edit.btnEnd'), callback_data: 'ed:f:end' }],
      [{ text: tr('edit.btnBreak'), callback_data: 'ed:f:brk' }],
      [{ text: tr('edit.btnReview'), callback_data: 'ed:review' }],
      [{ text: tr('edit.btnBackDetail'), callback_data: 'ed:back' }],
      [{ text: tr('common.cancel'), callback_data: 'ed:cancel' }],
    ] } };
  };

  const showEditMenu = async (ctx, st) => {
    const text = editMenuText(ctx, st);
    try {
      await ctx.editMessageText(text, editMenuKeyboard(ctx));
    } catch (e) {
      ctx.reply(text, editMenuKeyboard(ctx));
    }
  };

  bot.action(/^ed:edit:(\d+)$/, async (ctx) => {
    try {
      const emp = await getEmployee(ctx);
      const id = Number(ctx.match[1]);
      const row = await overtimeRepo.findById(id);
      if (!row || row.employee_id !== emp.id) {
        await ctx.answerCbQuery(T(ctx)('detail.notFoundToast')).catch(() => {});
        return undefined;
      }
      if (!OvertimeService.EDITABLE_STATUSES.includes(row.status)) {
        await ctx.answerCbQuery(T(ctx)('detail.notEditableToast', { status: statusLabel(ctx, row.status) })).catch(() => {});
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
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('detail.failOpenToast')).catch(() => {});
      return undefined;
    }
  });

  bot.action(/^ed:cancel$/, async (ctx) => {
    const had = editWizard.delete(ctx.from.id);
    await ctx.answerCbQuery(had ? T(ctx)('edit.cancelledToast') : T(ctx)('edit.noEditSessionToast')).catch(() => {});
    return ctx.reply(had ? T(ctx)('edit.cancelled') : T(ctx)('edit.noEditSession'));
  });

  const editExpired = (ctx) => T(ctx)('edit.expired');

  bot.action(/^ed:menu$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(editExpired(ctx)).catch(() => {});
    setEditState(ctx, 'menu');
    await showEditMenu(ctx, getEditState(ctx));
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  bot.action(/^ed:f:date$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(editExpired(ctx)).catch(() => {});
    const lang = L(ctx);
    setEditState(ctx, 'date');
    const view = { y: st.data.date.y, m: st.data.date.m };
    const text = `${T(ctx)('ov.calTitleNew', { id: st.sessionId, month: `${i18n.monthName(lang, view.m)} ${view.y}` })}\n${T(ctx)('edit.cancelHint')}`;
    const markup = { reply_markup: { inline_keyboard: calendarKeyboard(view.y, view.m, lang) } };
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
    if (!st) return ctx.answerCbQuery(editExpired(ctx)).catch(() => {});
    const field = ctx.match[1];
    setEditState(ctx, field);
    ctx.reply(T(ctx)(field === 'start' ? 'edit.promptStart' : 'edit.promptEnd', { id: st.sessionId, value: hhmm(st.data[field]) }));
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });

  bot.action(/^ed:f:brk$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(editExpired(ctx)).catch(() => {});
    const tr = T(ctx);
    setEditState(ctx, 'brk');
    ctx.reply(
      tr('edit.promptBreak', { id: st.sessionId, value: formatDurationId(st.data.breakMinutes || 0, L(ctx)) }),
      { reply_markup: { inline_keyboard: [
        [{ text: '☕ 0', callback_data: 'ed:b:0' }],
        [{ text: '☕ 30', callback_data: 'ed:b:30' }],
        [{ text: '☕ 45', callback_data: 'ed:b:45' }],
        [{ text: '☕ 60', callback_data: 'ed:b:60' }],
        [{ text: tr('ov.breakCustom'), callback_data: 'ed:b:custom' }],
        [{ text: tr('common.back'), callback_data: 'ed:menu' }],
      ] } }
    );
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  });
  bot.action(/^ed:b:(0|30|45|60|custom)$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st || st.step !== 'brk') {
      return ctx.answerCbQuery(T(ctx)('edit.brkInvalidToast')).catch(() => {});
    }
    const choice = ctx.match[1];
    if (choice === 'custom') {
      setEditState(ctx, 'brk_custom');
      await ctx.answerCbQuery().catch(() => {});
      return ctx.reply(T(ctx)('edit.brkCustomPrompt'));
    }
    st.data.breakMinutes = Number(choice);
    setEditState(ctx, 'menu');
    await showEditMenu(ctx, getEditState(ctx));
    await ctx.answerCbQuery(T(ctx)('edit.brkConfirmToast', { minutes: choice })).catch(() => {});
    return undefined;
  });

  bot.action(/^ed:back$/, async (ctx) => {
    // "Kembali ke detail": tampilkan ulang detail catatan (nilai tersimpan, bukan draf).
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(editExpired(ctx)).catch(() => {});
    const row = await overtimeRepo.findById(st.sessionId);
    if (!row || row.employee_id !== (await getEmployee(ctx)).id) {
      return ctx.answerCbQuery(T(ctx)('detail.notFoundToast')).catch(() => {});
    }
    const text = sessionDetailText(ctx, row);
    const markup = detailKeyboard(ctx, st.sessionId, row.status);
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

  const buildEditSummary = (ctx, st, minutes, overlapping) => {
    const lang = L(ctx);
    const tr = T(ctx);
    const o = st.orig; const d = st.data;
    const oldBrk = o.breakMinutes || 0;
    const newBrk = d.breakMinutes || 0;
    const line = (label, oldV, newV) => (oldV === newV
      ? tr('edit.sameLine', { label, value: oldV })
      : tr('edit.changeLine', { label, old: oldV, new: newV }));
    const tag = (cm) => (cm ? i18n.t(lang, 'common.crossMidnightTag') : '');
    const lines = [
      tr('edit.reviewTitle', { id: st.sessionId }),
      line(tr('edit.labelDate'), formatDateId(o.date, lang), formatDateId(d.date, lang)),
      line(tr('edit.labelStart'), hhmm(o.start), hhmm(d.start)),
      line(tr('edit.labelEnd'), hhmm(o.end) + tag(o.crossMidnight), hhmm(d.end) + tag(d.crossMidnight)),
      line(tr('edit.labelBreak'), formatDurationId(oldBrk, lang), formatDurationId(newBrk, lang)),
      line(tr('edit.labelGross'), formatDurationId(o.minutes, lang), formatDurationId(minutes, lang)),
      line(tr('edit.labelNet'), formatDurationId(o.minutes - oldBrk, lang), formatDurationId(minutes - newBrk, lang)),
    ];
    if (overlapping && overlapping.length) {
      lines.push('', tr('ov.overlapWarningEdit', { count: overlapping.length })
        + '\n' + overlapping.map((r) => `  - ${formatInTz(new Date(r.start_at), tz)} → ${formatInTz(new Date(r.end_at), tz)}`).join('\n'));
    }
    lines.push('', tr('edit.saveHint'));
    return lines.join('\n');
  };

  bot.command('input', startInput);

  const reviewKeyboard = (ctx) => {
    const tr = T(ctx);
    return { reply_markup: { inline_keyboard: [
      [{ text: tr('edit.btnSave'), callback_data: 'ed:save' }],
      [{ text: tr('edit.btnBackDetail'), callback_data: 'ed:back' }],
      [{ text: tr('common.cancel'), callback_data: 'ed:cancel' }],
    ] } };
  };

  bot.action(/^ed:review$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st) return ctx.answerCbQuery(editExpired(ctx)).catch(() => {});
    try {
      const emp = await getEmployee(ctx);
      const period = recomputeEditPeriod(st);
      st.data.minutes = period.minutes;
      const newBrk = st.data.breakMinutes || 0;
      if (newBrk >= period.minutes) {
        await ctx.answerCbQuery(T(ctx)('edit.brkExceedsToast', { minutes: newBrk, gross: period.minutes })).catch(() => {});
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
        await ctx.answerCbQuery(T(ctx)('edit.dupToast')).catch(() => {});
        return undefined;
      }
      const overlapping = existing.filter((r) => r.id !== st.sessionId && r.status !== 'rejected' && r.end_at
        && periodsOverlap(new Date(r.start_at), new Date(r.end_at), period.startUtc, period.endUtc));
      setEditState(ctx, 'review', { overlapping });
      const text = buildEditSummary(ctx, st, period.minutes, overlapping);
      await ctx.reply(text, reviewKeyboard(ctx));
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(`❌ ${err.userMessage ? E(ctx, err.userMessage) : (err.message || '')}`).catch(() => {});
      return undefined;
    }
  });

  bot.action(/^ed:save$/, async (ctx) => {
    const st = getEditState(ctx);
    if (!st || st.step !== 'review') {
      return ctx.answerCbQuery(T(ctx)('edit.invalidSessionToast')).catch(() => {});
    }
    const lang = L(ctx);
    const tr = T(ctx);
    try {
      const emp = await getEmployee(ctx);
      const result = await overtimeService.updateManualPeriod(emp, st.sessionId, {
        date: st.data.date, start: st.data.start, end: st.data.end,
        crossMidnight: st.data.crossMidnight, breakMinutes: st.data.breakMinutes || 0,
      }, { force: true });
      editWizard.delete(ctx.from.id);
      ctx.reply([
        tr('edit.saved', { id: st.sessionId }),
        tr('ov.summaryDate', { date: formatDateId(st.data.date, lang) }),
        tr('ov.savedStartEnd', {
          start: hhmm(st.data.start), end: hhmm(st.data.end),
        }) + (st.data.crossMidnight ? i18n.t(lang, 'common.crossMidnightTag') : ''),
        tr('ov.summaryGross', { duration: formatDurationId(result.grossMinutes, lang) }),
        tr('ov.summaryBreak', { duration: formatDurationId(result.breakMinutes, lang) }),
        tr('ov.summaryNet', { duration: formatDurationId(result.actualMinutes, lang) }),
        tr('ov.savedDayTotal', { duration: formatDurationId(result.dayTotalMinutes, lang) }),
      ].join('\n'));
      return undefined;
    } catch (err) {
      return ctx.reply(tr('edit.saveFailed', { reason: err.userMessage ? E(ctx, err.userMessage) : (err.message || '') }));
    }
  });

  bot.hears('📝 INPUT LEMBUR', startInput);
  hearsAllLanguages(bot, Object.values(LABELS.input), startInput);

  // ---- Ekspor Excel riwayat pribadi (callback "hexp:", dipicu dari tombol Riwayat) ----
  /** Keyboard pemilih periode: nav bulan + tombol ekspor bulan tampilan. */
  const historyExportKeyboard = (ctx, y, m, curY, curM) => {
    const lang = L(ctx);
    const tr = T(ctx);
    const shift = (yy, mm, delta) => {
      const d = new Date(Date.UTC(yy, mm - 1 + delta, 1));
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
    };
    const mm = String(m).padStart(2, '0');
    const prev = shift(y, m, -1);
    const row = [{ text: '◀️', callback_data: `hexp:nav:${prev.y}-${String(prev.m).padStart(2, '0')}` }];
    if (y * 12 + m < curY * 12 + curM) {
      const next = shift(y, m, 1);
      row.push({ text: '▶️', callback_data: `hexp:nav:${next.y}-${String(next.m).padStart(2, '0')}` });
    }
    return { reply_markup: { inline_keyboard: [
      row,
      [{ text: tr('hist.exportDo', { month: i18n.monthName(lang, m), year: y }), callback_data: `hexp:do:${y}-${mm}` }],
      [{ text: tr('common.cancel'), callback_data: 'hexp:cancel' }],
    ] } };
  };

  const renderHistoryExportPicker = async (ctx, y, m) => {
    const lang = L(ctx);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) {
      await ctx.answerCbQuery(T(ctx)('ov.monthInvalid')).catch(() => {});
      return undefined;
    }
    const nowP = toZonedParts(new Date(), tz);
    const [curY, curM] = nowP.date.split('-').map(Number);
    const text = T(ctx)('hist.exportTitle', { month: i18n.monthName(lang, m), year: y });
    const markup = historyExportKeyboard(ctx, y, m, curY, curM);
    try {
      await ctx.editMessageText(text, markup);
    } catch (e) {
      ctx.reply(text, markup);
    }
    await ctx.answerCbQuery().catch(() => {});
    return undefined;
  };

  bot.action(/^hexp:open$/, async (ctx) => {
    try {
      await getEmployee(ctx);
      const d = todayInTz(tz);
      return renderHistoryExportPicker(ctx, d.y, d.m);
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('pay.accountInactive')).catch(() => {});
      return undefined;
    }
  });

  bot.action(/^hexp:nav:(\d{4})-(\d{2})$/, async (ctx) => {
    try {
      await getEmployee(ctx);
      return renderHistoryExportPicker(ctx, Number(ctx.match[1]), Number(ctx.match[2]));
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('pay.accountInactive')).catch(() => {});
      return undefined;
    }
  });

  bot.action(/^hexp:do:(\d{4})-(\d{2})$/, async (ctx) => {
    const y = Number(ctx.match[1]);
    const m = Number(ctx.match[2]);
    if (y < 2000 || y > 2100 || m < 1 || m > 12) {
      await ctx.answerCbQuery(T(ctx)('ov.monthInvalid')).catch(() => {});
      return undefined;
    }
    let emp;
    try {
      emp = await getEmployee(ctx);
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('pay.accountInactive')).catch(() => {});
      return undefined;
    }
    await ctx.answerCbQuery(T(ctx)('pay.exporting')).catch(() => {});
    try {
      const result = await overtimeService.exportHistory(emp, y, m, L(ctx));
      if (result.empty) {
        ctx.reply(T(ctx)('pay.empty', { month: i18n.monthName(L(ctx), m), year: y }));
        return undefined;
      }
      await ctx.replyWithDocument({ source: result.buffer, filename: result.filename });
      return undefined;
    } catch (err) {
      // Jangan klaim file terkirim; laporkan kegagalan tanpa detail internal.
      await ctx.answerCbQuery(T(ctx)('pay.exportFailed')).catch(() => {});
      return undefined;
    }
  });

  bot.action(/^hexp:cancel$/, async (ctx) => {
    await ctx.answerCbQuery(T(ctx)('ov.cancelledToast')).catch(() => {});
    return undefined;
  });

  // ---- Konfirmasi simpan via tombol (callback "cnf:", terikat sesi wizard ctx.from.id) ----
  bot.action(/^cnf:(yes|no)$/, async (ctx) => {
    const tr = T(ctx);
    const st = getState(ctx);
    if (!st || st.step !== 'confirm') {
      // Sesi tidak ada / kedaluwarsa / bukan pemilik sesi (wizard per ctx.from.id) / replay.
      await ctx.answerCbQuery(tr('ov.sessionExpired')).catch(() => {});
      return undefined;
    }
    let emp;
    try {
      emp = requireActive(ctx);
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : tr('pay.accountInactive')).catch(() => {});
      return undefined;
    }
    // Hapus tombol agar tidak ditekan ulang (double-submit).
    await ctx.editMessageReplyMarkup(undefined).catch(() => {});
    if (ctx.match[1] === 'no') {
      wizard.delete(ctx.from.id);
      await ctx.answerCbQuery().catch(() => {});
      ctx.reply(tr('ov.cancelled'));
      return undefined;
    }
    await ctx.answerCbQuery().catch(() => {});
    await saveConfirmed(ctx, emp, st.data);
    return undefined;
  });

  // ---- Navigasi rekap bulanan (callback dari keyboard "Status Lembur Saya") ----
  bot.action(/^pay:(\d{4})-(\d{2})$/, async (ctx) => {
    try {
      const y = Number(ctx.match[1]);
      const m = Number(ctx.match[2]);
      if (y < 2000 || y > 2100 || m < 1 || m > 12) {
        await ctx.answerCbQuery(T(ctx)('ov.monthInvalid')).catch(() => {});
        return undefined;
      }
      const emp = employeeService
        ? await employeeService.requireActiveEmployee(ctx.from.id)
        : requireActive(ctx);
      const lang = L(ctx);
      const monthly = await overtimeService.getMonthlyPayroll(emp, y, m, lang);
      const nowP = toZonedParts(new Date(), tz);
      const [curY, curM] = nowP.date.split('-').map(Number);
      const replyMarkup = { reply_markup: { inline_keyboard: navKeyboard(y, m, curY, curM, lang) } };
      try {
        await ctx.editMessageText(monthly.text, replyMarkup);
      } catch (e) {
        ctx.reply(monthly.text, replyMarkup);
      }
      await ctx.answerCbQuery().catch(() => {});
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : T(ctx)('pay.failLoad')).catch(() => {});
      return undefined;
    }
  });

  // ---- Ekspor Excel rekap bulanan (callback dari tombol "Export Excel") ----
  bot.action(/^exp:(\d{4})-(\d{2})$/, async (ctx) => {
    const tr = T(ctx);
    const parsed = parseMonthParam(`${ctx.match[1]}-${ctx.match[2]}`);
    if (!parsed) {
      await ctx.answerCbQuery(tr('ov.monthInvalid')).catch(() => {});
      return undefined;
    }
    let emp;
    try {
      emp = employeeService
        ? await employeeService.requireActiveEmployee(ctx.from.id)
        : requireActive(ctx);
    } catch (err) {
      await ctx.answerCbQuery(err.userMessage ? E(ctx, err.userMessage) : tr('pay.accountInactive')).catch(() => {});
      return undefined;
    }
    await ctx.answerCbQuery(tr('pay.exporting')).catch(() => {});
    try {
      const { buffer, filename } = await overtimeService.exportMonthlyPayroll(emp, parsed.y, parsed.m);
      await ctx.replyWithDocument({ source: buffer, filename });
      return undefined;
    } catch (err) {
      // Jangan klaim file terkirim; laporkan kegagalan tanpa detail internal.
      await ctx.answerCbQuery(tr('pay.exportFailed')).catch(() => {});
      return undefined;
    }
  });
}

module.exports = { registerOvertimeHandlers };
