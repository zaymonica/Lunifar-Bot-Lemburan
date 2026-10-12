'use strict';
const { mainMenu, LABELS } = require('../keyboards');
const { ValidationError } = require('../../utils/errors');
const { sanitizeText } = require('../../services/employee.service');
const { toZonedParts } = require('../../utils/date-time');
const { navKeyboard } = require('../../services/payroll');
const i18n = require('../../i18n');

/** {y,m,d} hari ini pada zona waktu aplikasi. */
function todayInTz(timeZone) {
  const p = toZonedParts(new Date(), timeZone);
  const [y, m, d] = p.date.split('-').map(Number);
  return { y, m, d };
}

/** Bahasa pengguna dari ctx (state.employee oleh middleware); default 'id'. */
function langOf(ctx) {
  return i18n.normalizeLang(ctx.state && ctx.state.employee && ctx.state.employee.language);
}
const T = (ctx) => (key, params) => i18n.t(langOf(ctx), key, params);

/** Escape HTML (parse_mode 'HTML') untuk data dinamis dari input pengguna. */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Nama sapaan aman: ctx.from.first_name, fallback last_name, lalu label netral.
 * Selalu di-escape (HTML) karena disisipkan ke pesan parse_mode 'HTML'.
 */
function greetName(ctx, lang) {
  const raw = (ctx.from && (ctx.from.first_name || ctx.from.last_name || '').trim())
    || (lang === 'en' ? 'friend' : lang === 'zh-TW' ? '朋友' : lang === 'vi' ? 'bạn' : 'Sahabat');
  return escapeHtml(raw.slice(0, 64));
}

/** Teks bantuan per bahasa (HELP_TEXT lama = versi 'id', tetap diekspor). */
function helpText(lang = 'id') {
  return [
    i18n.t(lang, 'help.title'),
    '',
    i18n.t(lang, 'help.intro'),
    '',
    i18n.t(lang, 'help.commands'),
    i18n.t(lang, 'help.cmdStart'),
    i18n.t(lang, 'help.cmdStatus'),
    i18n.t(lang, 'help.cmdHistory'),
    i18n.t(lang, 'help.cmdLanguage'),
    i18n.t(lang, 'help.cmdHelp'),
    '',
    i18n.t(lang, 'help.menu'),
    i18n.t(lang, 'help.menuInput'),
    i18n.t(lang, 'help.menuStatus'),
    i18n.t(lang, 'help.menuHistory'),
    i18n.t(lang, 'help.menuProfile'),
    '',
    i18n.t(lang, 'help.notes'),
    i18n.t(lang, 'help.crossMidnight'),
    i18n.t(lang, 'help.overlap'),
  ].join('\n');
}
const HELP_TEXT = helpText('id');

/** Keyboard pemilih bahasa (callback_data stabil: lang:<code>). */
function languageKeyboard() {
  return {
    inline_keyboard: i18n.LANGUAGES.map(({ code, buttonKey }) => [
      { text: i18n.t('id', buttonKey), callback_data: `lang:${code}` },
    ]),
  };
}

function registerCommonHandlers(bot, services) {
  const { employeeService, overtimeService } = services;
  const { config } = services;

  bot.start(async (ctx) => {
    const tgId = ctx.from.id;
    const lang = langOf(ctx);
    let emp = ctx.state.employee;
    if (emp && emp.status !== 'active') {
      // Aktivasi otomatis untuk status lama 'pending' (alur pribadi tanpa admin).
      try { emp = await employeeService.requireActiveEmployee(tgId); } catch (err) { emp = null; }
    }
    if (emp && emp.status === 'active' && emp.is_active) {
      // Sambutan menyebut nama Telegram (first_name, fallback aman) — bukan nama karyawan.
      return ctx.reply(i18n.t(lang, 'start.greeting', { name: greetName(ctx, lang) }), {
        parse_mode: 'HTML',
        reply_markup: mainMenu(lang),
        link_preview_options: { is_disabled: true },
      });
    }
    if (emp && emp.status === 'rejected') {
      return ctx.reply(i18n.t(lang, 'start.rejected'));
    }
    // Pengguna baru: sambutan + arahan registrasi (dua pesan terpisah, markup berbeda).
    await ctx.reply(i18n.t(lang, 'start.greeting', { name: greetName(ctx, lang) }), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    ctx.reply(i18n.t(lang, 'start.welcome'), { parse_mode: 'Markdown' });
  });

  bot.command('daftar', async (ctx) => {
    const lang = langOf(ctx);
    const raw = (ctx.message.text || '').replace(/^\/daftar\s*/i, '').trim();
    const parts = raw.split('|').map((p) => p.trim());
    if (parts.length < 2 || !parts[0]) {
      return ctx.reply(i18n.t(lang, 'register.format'), { parse_mode: 'Markdown' });
    }
    try {
      await employeeService.register({
        telegramUserId: ctx.from.id,
        fullName: parts[0],
        employeeNumber: parts[1] || null,
        department: parts[2] || i18n.t(lang, 'register.deptDefault'),
      });
      ctx.reply(i18n.t(lang, 'register.success'), { parse_mode: 'Markdown' });
    } catch (err) {
      ctx.reply(err.userMessage ? i18n.trError(lang, err.userMessage) : i18n.t(lang, 'register.failed'));
    }
  });

  // ---- Pemilihan bahasa (/language + tombol) ----
  bot.command('language', (ctx) => ctx.reply(i18n.t(langOf(ctx), 'language.title'), { reply_markup: languageKeyboard() }));

  bot.action(/^lang:([a-zA-Z-]+)$/, async (ctx) => {
    const code = ctx.match[1];
    const tgId = ctx.from && ctx.from.id;
    try {
      // Validasi + simpan via service (repo). Fallback 'id' untuk bahasa tak dikenal.
      let lang;
      try {
        lang = await employeeService.setLanguage(tgId, code);
      } catch (err) {
        lang = i18n.normalizeLang(code);
        if (lang !== code) {
          await ctx.answerCbQuery(i18n.t(lang, 'language.invalid')).catch(() => {});
          return undefined;
        }
      }
      const emp = ctx.state.employee;
      if (emp) emp.language = lang; // cache sesi ikut berubah
      await ctx.answerCbQuery().catch(() => {});
      const confirm = i18n.t(lang, 'language.changed', { name: i18n.langDisplayName(lang) });
      // Reply keyboard di-refresh SEKARANG agar menu berbahasa baru langsung berlaku.
      ctx.reply(confirm, { reply_markup: mainMenu(lang) });
      return undefined;
    } catch (err) {
      await ctx.answerCbQuery(i18n.t(langOf(ctx), 'common.answerError')).catch(() => {});
      return undefined;
    }
  });

  bot.command('help', (ctx) => ctx.reply(helpText(langOf(ctx)), { parse_mode: 'Markdown' }));

  /** Register handler "hears" untuk label menu dalam SEMUA bahasa + label lama. */
  const hearsAll = (labels, handler) => {
    const escaped = labels.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    bot.hears(new RegExp(`^(?:${escaped.join('|')})$`), handler);
  };
  hearsAll(Object.values(LABELS.help), (ctx) => ctx.reply(helpText(langOf(ctx)), { parse_mode: 'Markdown' }));
  hearsAll(Object.values(LABELS.language), (ctx) => ctx.reply(
    i18n.t(langOf(ctx), 'language.title'),
    { reply_markup: languageKeyboard() }
  ));

  /** Render status harian + rekap bulanan (dipakai command dan tombol menu). */
  async function renderStatus(ctx, emp) {
    const lang = langOf(ctx);
    const st = await overtimeService.myStatus(emp, config.timezone);
    let msg = st.running
      ? i18n.t(lang, 'status.running', { since: st.running.since, minutes: st.running.elapsedMinutes })
      : i18n.t(lang, 'status.none');
    const today = await overtimeService.getDailyRecap(emp, todayInTz(config.timezone), config.timezone);
    if (today.text) msg += '\n\n' + today.text;
    const nowParts = toZonedParts(new Date(), config.timezone);
    const [curY, curM] = nowParts.date.split('-').map(Number);
    const monthly = await overtimeService.getMonthlyPayroll(emp, curY, curM, lang);
    msg += '\n\n' + monthly.text;
    ctx.reply(msg, { reply_markup: { inline_keyboard: navKeyboard(curY, curM, curY, curM, lang) } });
  }

  const showStatus = async (ctx) => {
    const lang = langOf(ctx);
    try {
      const emp = await employeeService.requireActiveEmployee(ctx.from.id);
      await renderStatus(ctx, emp);
    } catch (err) {
      ctx.reply(err.userMessage ? i18n.trError(lang, err.userMessage) : i18n.t(lang, 'status.fail'));
    }
  };
  bot.command('status', showStatus);
  hearsAll(Object.values(LABELS.status), showStatus);

  const showProfile = (ctx) => {
    const lang = langOf(ctx);
    const emp = ctx.state.employee;
    if (!emp) return ctx.reply(i18n.t(lang, 'common.notRegistered'));
    ctx.reply([
      i18n.t(lang, 'profile.title'),
      i18n.t(lang, 'profile.name', { name: emp.full_name }),
      i18n.t(lang, 'profile.empNum', { value: emp.employee_number || '-' }),
      i18n.t(lang, 'profile.dept', { value: emp.department }),
      i18n.t(lang, 'profile.status', { value: emp.status }),
      i18n.t(lang, 'profile.role', { value: emp.role }),
    ].join('\n'));
  };
  bot.command('profile', showProfile);
  hearsAll(Object.values(LABELS.profile), showProfile);
}

module.exports = { registerCommonHandlers, HELP_TEXT, helpText, languageKeyboard, langOf };
