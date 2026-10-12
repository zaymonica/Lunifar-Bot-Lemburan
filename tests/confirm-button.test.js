'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');
const { registerCommonHandlers } = require('../src/bot/handlers/common');
const { mainMenu, LABELS, ALL_LABELS } = require('../src/bot/keyboards');
const i18n = require('../src/i18n');

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

function makeServices({ created = [], stateRef = { employee: null } } = {}) {
  const emp = { id: 7, telegram_user_id: 42, full_name: 'Budi', status: 'active', is_active: 1, language: 'id' };
  return {
    config: { timezone: TZ },
    employeeService: {
      // Kontrak nyata: repo membaca DB — di fake, baca stateRef agar mencerminkan ctx.state.
      requireActiveEmployee: async (tg) => {
        const cur = stateRef.employee;
        if (tg !== 42 || !cur) throw new Error('not found');
        if (cur.status === 'rejected' || cur.status === 'inactive' || !cur.is_active) {
          const e = new Error('akun tidak aktif'); e.userMessage = e.message; throw e;
        }
        return cur;
      },
      getLanguage: () => emp.language,
      setLanguage: async (_tg, lang) => { emp.language = lang; return lang; },
      register: async () => ({}),
    },
    overtimeService: {
      async createManualPeriod(_emp, input) {
        created.push(input);
        return {
          session: { id: 1 }, actualMinutes: input.breakMinutes ? 120 : 150,
          grossMinutes: 150, breakMinutes: input.breakMinutes || 0, dayTotalMinutes: 150,
        };
      },
      async myStatus() { return { running: null }; },
      async getDailyRecap() { return { rows: [], text: null }; },
      async getMonthlyPayroll() { return { text: '' }; },
    },
    overtimeRepo: {
      listByEmployee: async () => [],
      listByEmployeeAndWindow: async () => [],
      findById: async () => null,
    },
    created,
  };
}

function makeCtx(id, employee) {
  const ctx = {
    from: { id },
    state: { employee },
    message: null,
    replies: [], edits: [], toasts: [], markupRemoved: 0,
    reply: async (t, o) => { ctx.replies.push({ t, o }); },
    editMessageText: async (t, o) => { ctx.edits.push({ t, o }); },
    editMessageReplyMarkup: async () => { ctx.markupRemoved += 1; },
    answerCbQuery: async (t) => { ctx.toasts.push(t); },
    match: null,
  };
  return ctx;
}

const fireHears = async (handlers, ctx, text) => {
  const match = handlers.hears.find(([t]) => (t instanceof RegExp ? t.test(text) : t === text));
  assert.ok(match, `hears tidak terdaftar untuk: ${text}`);
  ctx.message = { text };
  await match[1](ctx);
};
const fireAction = async (handlers, ctx, data) => {
  const match = handlers.action.find(([re]) => re.test(data));
  assert.ok(match, `action tidak terdaftar: ${data}`);
  const choice = (data.match(/:(.+)$/) || [])[1];
  ctx.match = [data, choice];
  await match[1](ctx);
};
const fireText = async (handlers, ctx, text) => {
  const [, h] = handlers.on.find(([e]) => e === 'text');
  ctx.message = { text };
  await h(ctx);
};

/** Jalankan alur input sampai langkah konfirmasi; kembalikan ctx. */
async function reachConfirm(handlers, ctx) {
  await fireHears(handlers, ctx, '📝 INPUT LEMBUR');
  await fireText(handlers, ctx, '16:30');
  await fireText(handlers, ctx, '19:00'); // 150 menit
  await fireAction(handlers, ctx, 'brk:0');
  await new Promise((r) => setTimeout(r, 5)); // evaluatePeriod async
  const summary = ctx.replies.findLast((r) => r.t.includes('Ringkasan input lembur'));
  if (!summary) {
    throw new Error('ringkasan konfirmasi tampil — balasan: ' + JSON.stringify(ctx.replies.map((r) => r.t.slice(0, 80))));
  }
  assert.ok(summary.o.reply_markup.inline_keyboard[0].some((b) => b.callback_data === 'cnf:yes'));
  return summary;
}

test('konfirmasi: tombol Ya/Tidak dalam 4 bahasa sesuai katalog', async () => {
  for (const lang of ['id', 'en', 'zh-TW', 'vi']) {
    assert.strictEqual(i18n.t(lang, 'confirm.yesBtn'),
      { id: '✅ Ya, Simpan', en: '✅ Yes, Save', 'zh-TW': '✅ 是，儲存', vi: '✅ Có, lưu' }[lang]);
    assert.strictEqual(i18n.t(lang, 'confirm.noBtn'),
      { id: '❌ Tidak, Batal', en: '❌ No, Cancel', 'zh-TW': '❌ 否，取消', vi: '❌ Không, hủy' }[lang]);
  }
});

test('konfirmasi: tombol Ya menyimpan lembur (alur & validasi lama berjalan)', async () => {
  const { bot, handlers } = makeBot();
  const services = makeServices();
  registerOvertimeHandlers(bot, services);
  const ctx = makeCtx(42, { id: 7, status: 'active', is_active: 1, language: 'id' });
  await reachConfirm(handlers, ctx);
  await fireAction(handlers, ctx, 'cnf:yes');
  assert.strictEqual(services.created.length, 1, 'createManualPeriod dipanggil tepat sekali');
  assert.strictEqual(services.created[0].breakMinutes, 0);
  assert.ok(ctx.replies.some((r) => r.t.includes('✅ Periode lembur tersimpan.')));
  assert.strictEqual(ctx.markupRemoved, 1, 'tombol dihapus setelah ditekan');
  // Replay callback → sesi sudah terhapus
  await fireAction(handlers, ctx, 'cnf:yes');
  assert.ok(ctx.toasts.some((t) => t && t.includes('Sesi input sudah berakhir')));
});

test('konfirmasi: tombol Tidak membatalkan TANPA menyimpan data', async () => {
  const { bot, handlers } = makeBot();
  const services = makeServices();
  registerOvertimeHandlers(bot, services);
  const ctx = makeCtx(42, { id: 7, status: 'active', is_active: 1, language: 'id' });
  await reachConfirm(handlers, ctx);
  await fireAction(handlers, ctx, 'cnf:no');
  assert.strictEqual(services.created.length, 0, 'tidak ada data tersimpan');
  assert.ok(ctx.replies.some((r) => r.t.includes('❌ Input lembur dibatalkan. Tidak ada data yang disimpan.')));
  // Replay setelah batal → sesi kedaluwarsa
  await fireAction(handlers, ctx, 'cnf:no');
  assert.ok(ctx.toasts.some((t) => t && t.includes('Sesi input sudah berakhir')));
});

test('konfirmasi: teks "ya"/"tidak" lama tetap didukung (kompatibilitas)', async () => {
  const { bot, handlers } = makeBot();
  const services = makeServices();
  registerOvertimeHandlers(bot, services);
  const ctx = makeCtx(42, { id: 7, status: 'active', is_active: 1, language: 'id' });
  await reachConfirm(handlers, ctx);
  await fireText(handlers, ctx, 'ya');
  assert.strictEqual(services.created.length, 1);
});

test('konfirmasi: callback pengguna lain tidak dapat menyimpan sesi milik orang lain', async () => {
  const { bot, handlers } = makeBot();
  const services = makeServices();
  registerOvertimeHandlers(bot, services);
  // Pengguna 99 tidak pernah memulai sesi → cnf:yes harus ditolak.
  const ctx = makeCtx(99, { id: 99, status: 'active', is_active: 1, language: 'id' });
  await fireAction(handlers, ctx, 'cnf:yes');
  assert.strictEqual(services.created.length, 0);
  assert.ok(ctx.toasts.some((t) => t && t.includes('Sesi input sudah berakhir')));
  // Pengguna non-aktif juga ditolak (requireActive).
  const ctx2 = makeCtx(42, { id: 7, status: 'inactive', is_active: 0, language: 'id' });
  // Sesi milik 42 ada jika kita mulai dengan pengguna aktif; simulasi: mulai lalu nonaktifkan.
  const ctxOk = makeCtx(42, { id: 7, status: 'active', is_active: 1, language: 'id' });
  const { bot: b2, handlers: h2 } = makeBot();
  const services2 = makeServices();
  registerOvertimeHandlers(b2, services2);
  await reachConfirm(h2, ctxOk);
  ctx2.state.employee = { id: 7, status: 'inactive', is_active: 0, language: 'id' };
  await fireAction(h2, ctx2, 'cnf:yes');
  assert.strictEqual(services2.created.length, 0, 'akun non-aktif tidak bisa menyimpan');
});

test('tombol 🌐 di menu utama: tersedia untuk semua bahasa, label lama utuh, legacy 5 tombol', () => {
  for (const lang of ['id', 'en', 'zh-TW', 'vi']) {
    const kb = mainMenu(lang).keyboard.flat();
    assert.strictEqual(kb.length, 6, lang);
    assert.strictEqual(kb[5], i18n.t(lang, 'menu.language'));
    // Label lama tetap ada.
    for (const old of ['📝 INPUT LEMBUR', '📋 Status Lembur Saya', '📁 Riwayat Lembur', '👤 Profil Saya', '❓ Bantuan']) {
      assert.ok(ALL_LABELS.includes(old));
    }
  }
  // Legacy tanpa argumen: persis 5 tombol lama (kompatibilitas test lama).
  assert.strictEqual(mainMenu().keyboard.flat().length, 5);
});

test('tombol 🌐 membuka pemilih bahasa dan menyimpan pilihan + refresh menu', async () => {
  const { bot, handlers } = makeBot();
  const services = makeServices();
  registerCommonHandlers(bot, services);
  const ctx = makeCtx(42, { id: 7, full_name: 'Budi', status: 'active', is_active: 1, language: 'id' });
  await fireHears(handlers, ctx, '🌐 語言');
  assert.strictEqual(ctx.replies.length, 1);
  const cb = ctx.replies[0].o.reply_markup.inline_keyboard.map((r) => r[0].callback_data);
  assert.deepStrictEqual(cb, ['lang:id', 'lang:en', 'lang:zh-TW', 'lang:vi']);
  // Pilih vi → tersimpan + menu dalam bahasa baru.
  const [, langAction] = handlers.action.find(([re]) => re.source.includes('lang:'));
  ctx.match = ['lang:vi', 'vi'];
  await langAction(ctx);
  assert.strictEqual(ctx.state.employee.language, 'vi');
  const menu = ctx.replies[1].o.reply_markup.keyboard.flat();
  assert.strictEqual(menu[0], LABELS.input.vi);
  assert.strictEqual(menu[5], LABELS.language.vi, 'menu bahasa baru memuat tombol 🌐');
  // /language tetap didukung.
  const ctx2 = makeCtx(42, { id: 7, status: 'active', is_active: 1, language: 'vi' });
  const [, langCmd] = handlers.command.find(([c]) => c === 'language');
  await langCmd(ctx2);
  assert.ok(ctx2.replies[0].o.reply_markup.inline_keyboard.length === 4);
});

// ---------- Sambutan /start (nama Telegram dinamis + link pembuat) ----------

test('sambutan /start: nama depan dinamis + link pembuat + escape HTML', async () => {
  const { bot, handlers } = makeBot();
  const stateRef = { employee: null };
  const services = makeServices({ stateRef });
  registerCommonHandlers(bot, services);

  const runStart = async (employee, from) => {
    stateRef.employee = employee;
    const c = makeCtx(42, employee);
    c.from = from;
    const [, startHandler] = handlers.command.find(([cmd]) => cmd === 'start');
    await startHandler(c);
    return c;
  };

  // Nama depan dipakai; markup HTML; link t.me/drt1212 ada di keempat bahasa.
  const c1 = await runStart({ id: 7, status: 'active', is_active: 1, language: 'id' }, { id: 42, first_name: 'Budi' });
  assert.ok(c1.replies[0].t.startsWith('👋 Selamat Datang, Budi, di Bot Pencatat Lemburan!'), c1.replies[0].t.slice(0, 60));
  assert.ok(c1.replies[0].t.includes('perhitungan gaji tahun 2026'));
  assert.ok(c1.replies[0].t.includes('<a href="https://t.me/drt1212">Imron Hoerudin (魯丁)</a>'));
  assert.strictEqual(c1.replies[0].o.parse_mode, 'HTML');
  assert.ok(c1.replies[0].o.reply_markup.keyboard.length === 4, 'menu berbahasa dilampirkan');

  // Fallback tanpa first_name → label netral, tidak crash, tetap escape.
  const c2 = await runStart({ id: 7, status: 'active', is_active: 1, language: 'en' }, { id: 42, first_name: '' });
  assert.ok(c2.replies[0].t.includes('Welcome, friend,'));

  // Injection HTML di first_name di-escape (tidak merusak markup).
  const c3 = await runStart({ id: 7, status: 'active', is_active: 1, language: 'id' },
    { id: 42, first_name: '<b>Eve</b> & "x"' });
  assert.ok(c3.replies[0].t.includes('&lt;b&gt;Eve&lt;/b&gt; &amp; &quot;x&quot;'));
  assert.ok(!c3.replies[0].t.includes('<b>Eve</b>'));

  // Empat bahasa memuat link pembuat dengan teks terjemahan berbeda.
  const firsts = {
    id: '👋 Selamat Datang', en: '👋 Welcome', 'zh-TW': '👋 歡迎您', vi: '👋 Xin chào',
  };
  for (const [lang, prefix] of Object.entries(firsts)) {
    const c = await runStart({ id: 7, status: 'active', is_active: 1, language: lang }, { id: 42, first_name: 'A' });
    // id/en/vi memakai koma ASCII; zh-TW memakai koma penuh '，'.
    assert.ok(c.replies[0].t.startsWith(prefix), lang + ': ' + c.replies[0].t.slice(0, 40));
    assert.ok(/, A,|，A，/.test(c.replies[0].t.slice(0, 40)), lang);
    assert.ok(c.replies[0].t.includes('t.me/drt1212'), lang);
    assert.strictEqual(c.replies[0].o.parse_mode, 'HTML', lang);
  }

  // Pengguna baru: sambutan + arahan registrasi dua pesan.
  const cNew = await runStart(null, { id: 42, first_name: 'Budi' });
  assert.strictEqual(cNew.replies.length, 2);
  assert.ok(cNew.replies[0].t.includes('👋 Selamat Datang, Budi,'));
  assert.ok(cNew.replies[1].t.includes('/daftar'), 'arahan registrasi tetap ada');

  // Status rejected: requireActiveEmployee melempar AuthError → tertangkap → emp=null
  // → jalur registrasi (perilaku PRA-ADA yang dipertahankan, tidak diubah di sini).
  const cRej = await runStart({ id: 7, status: 'rejected', is_active: 1, language: 'id' }, { id: 42, first_name: 'X' });
  assert.strictEqual(cRej.replies.length, 2, 'rejected jatuh ke jalur registrasi (perilaku lama)');
  assert.ok(cRej.replies[0].t.includes('👋 Selamat Datang'));

  // Nama >64 karakter dipotong (batas aman).
  const cLong = await runStart({ id: 7, status: 'active', is_active: 1, language: 'id' },
    { id: 42, first_name: 'A'.repeat(200) });
  assert.ok(cLong.replies[0].t.includes('A'.repeat(64)));
  assert.ok(!cLong.replies[0].t.includes('A'.repeat(65)));
});
