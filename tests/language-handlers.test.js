'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');
const i18n = require('../src/i18n');
const { registerCommonHandlers } = require('../src/bot/handlers/common');
const { mainMenu, LABELS } = require('../src/bot/keyboards');

const TZ = 'Asia/Taipei';

function makeBot() {
  const handlers = { action: [], hears: [], command: [], on: [] };
  const bot = {
    action: (re, h) => handlers.action.push([re, h]),
    hears: (t, h) => handlers.hears.push([t, h]),
    command: (c, h) => handlers.command.push([c, h]),
    on: (ev, h) => handlers.on.push([ev, h]),
    start: (h) => handlers.command.push(['start', h]),
  };
  return { bot, handlers };
}

// makeCtx di atas punya self-reference bug bila ditulis seadanya; pakai versi sederhana:
function ctxFor(id, employee) {
  const ctx = {
    from: { id },
    state: { employee },
    message: null,
    replies: [],
    edits: [],
    reply: async (t, o) => { ctx.replies.push({ t, o }); },
    editMessageText: async (t, o) => { ctx.edits.push({ t, o }); },
    answerCbQuery: async () => {},
    match: null,
  };
  return ctx;
}

function makeServices({ language = 'id', setLanguageCalls = [] } = {}) {
  const emp = { id: 7, telegram_user_id: 42, full_name: 'Budi', status: 'active', is_active: 1, language };
  return {
    config: { timezone: TZ },
    overtimeService: {
      async myStatus() { return { running: null, recent: [] }; },
      async getDailyRecap() { return { rows: [], text: null }; },
      async getMonthlyPayroll(_e, y, m, lang) {
        return { aggregate: null, text: `RECAP_${lang}_${y}_${m}` };
      },
    },
    employeeService: {
      requireActiveEmployee: async () => emp,
      getLanguage: () => language,
      // Tiru kontrak service nyata: kode tak dikenal → ValidationError.
      setLanguage: async (_tg, lang) => {
        const norm = i18n.normalizeLang(lang);
        if (norm !== String(lang || '').trim()) {
          const err = new Error('language.invalid'); err.userMessage = err.message;
          throw err;
        }
        setLanguageCalls.push(lang);
        return lang;
      },
      register: async () => ({}),
    },
    overtimeRepo: {
      listByEmployee: async () => [],
      listByEmployeeAndWindow: async () => [],
      findById: async () => null,
    },
  };
}

test('tombol menu dalam bahasa non-Indonesia memicu handler yang sama', async () => {
  const { bot, handlers } = makeBot();
  registerOvertimeHandlers(bot, makeServices());
  const hearsRe = handlers.hears.filter(([t]) => t instanceof RegExp);
  assert.ok(hearsRe.length >= 2, 'harus ada regex hears lintas bahasa');
  // '📁 加班紀錄' (zh-TW) harus dicocokkan salah satu regex.
  const anyMatch = hearsRe.some(([re]) => re.test('📁 加班紀錄'));
  const inputMatch = hearsRe.some(([re]) => re.test('📝 輸入加班'));
  const viMatch = hearsRe.some(([re]) => re.test('📝 NHẬP TĂNG CA'));
  assert.ok(anyMatch && inputMatch && viMatch);
  // Label lama tetap dicocokkan string persis maupun regex.
  const strLabels = handlers.hears.filter(([t]) => typeof t === 'string').map(([t]) => t);
  assert.ok(strLabels.includes('📁 Riwayat Lembur'));
  assert.ok(strLabels.includes('📝 INPUT LEMBUR'));
});

test('callback lang:<code> menyimpan bahasa & mengirim keyboard menu bahasa baru', async () => {
  const calls = [];
  const { bot, handlers } = makeBot();
  registerCommonHandlers(bot, makeServices({ setLanguageCalls: calls }));
  const ctx = ctxFor(42, { id: 7, full_name: 'Budi', status: 'active', is_active: 1, language: 'id' });
  const action = handlers.action.find(([re]) => re.source.includes('lang:'))[1];
  ctx.match = ['lang:zh-TW', 'zh-TW'];
  await action(ctx);
  assert.deepStrictEqual(calls, ['zh-TW'], 'setLanguage harus dipanggil dengan kode bahasa');
  assert.strictEqual(ctx.replies.length, 1);
  const kbJson = JSON.stringify(ctx.replies[0].o.reply_markup);
  assert.ok(kbJson.includes('輸入加班'), 'reply keyboard harus dalam bahasa baru');
  assert.ok(ctx.replies[0].t.includes('繁體中文（台灣）'), 'konfirmasi dalam bahasa baru');
});

test('callback lang: kode tak dikenal tidak menyimpan & tidak kirim menu', async () => {
  const calls = [];
  const { bot, handlers } = makeBot();
  registerCommonHandlers(bot, makeServices({ setLanguageCalls: calls }));
  const ctx = ctxFor(42, { id: 7, full_name: 'Budi', status: 'active', is_active: 1, language: 'id' });
  const action = handlers.action.find(([re]) => re.source.includes('lang:'))[1];
  ctx.match = ['lang:xx', 'xx'];
  await action(ctx);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(ctx.replies.length, 0);
});
