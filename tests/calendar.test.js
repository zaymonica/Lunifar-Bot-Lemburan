'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { todayInTz, parseCalDate, formatDateId, calendarKeyboard } = require('../src/services/calendar');
const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');

const TZ = 'Asia/Taipei';

// ---------- Modul murni ----------

test('parseCalDate: ketat + kabisat', () => {
  assert.deepStrictEqual(parseCalDate('2026-10-11'), { y: 2026, m: 10, d: 11 });
  assert.deepStrictEqual(parseCalDate('2024-02-29'), { y: 2024, m: 2, d: 29 }); // kabisat
  assert.strictEqual(parseCalDate('2026-02-29'), null); // bukan kabisat
  assert.strictEqual(parseCalDate('2024-02-30'), null);
  assert.strictEqual(parseCalDate('2026-13-01'), null);
  assert.strictEqual(parseCalDate('2026-10-32'), null);
  assert.strictEqual(parseCalDate('11-10-2026'), null);
  assert.strictEqual(parseCalDate(''), null);
  assert.strictEqual(parseCalDate(null), null);
});

test('formatDateId: format mudah dibaca', () => {
  assert.strictEqual(formatDateId({ y: 2026, m: 10, d: 11 }), '11 Oktober 2026');
  assert.strictEqual(formatDateId({ y: 2024, m: 2, d: 29 }), '29 Februari 2024');
});

test('calendarKeyboard: Februari kabisat 29 hari, biasa 28 hari', () => {
  const countDays = (kb) => kb.flat().filter((b) => b.callback_data.startsWith('cal:sel:')).length;
  assert.strictEqual(countDays(calendarKeyboard(2024, 2)), 29);
  assert.strictEqual(countDays(calendarKeyboard(2026, 2)), 28);
  assert.strictEqual(countDays(calendarKeyboard(2026, 10)), 31);
});

test('calendarKeyboard: nama bulan, baris nama hari, alignment & navigasi antar tahun', () => {
  const kb = calendarKeyboard(2026, 10);
  assert.strictEqual(kb[0][1].text, 'Oktober 2026');
  assert.deepStrictEqual(kb[1].map((b) => b.text), ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab']);
  // 1 Oktober 2026 = Kamis (indeks 4) → 4 sel kosong sebelum tanggal 1.
  const week1 = kb[2];
  const firstDayIdx = week1.findIndex((b) => b.text === '1');
  assert.strictEqual(firstDayIdx, 4);
  assert.strictEqual(week1[0].callback_data, 'cal:noop');
  // Navigasi lintas tahun (callback = bulan target tampilan).
  assert.strictEqual(calendarKeyboard(2026, 12)[0][2].callback_data, 'cal:next:2027-01');
  assert.strictEqual(calendarKeyboard(2026, 1)[0][0].callback_data, 'cal:prev:2025-12');
  // Footer.
  assert.deepStrictEqual(kb[kb.length - 1].map((b) => b.text), ['Hari Ini', 'Batal']);
  // Input tidak valid.
  assert.strictEqual(calendarKeyboard(2026, 13), null);
  assert.strictEqual(calendarKeyboard('x', 10), null);
});

test('callback kalender tidak bentrok dengan pay:/exp:', () => {
  for (const kb of [calendarKeyboard(2026, 10), calendarKeyboard(2024, 2)]) {
    for (const b of kb.flat()) {
      assert.ok(!b.callback_data.startsWith('pay:'));
      assert.ok(!b.callback_data.startsWith('exp:'));
      assert.ok(b.callback_data.startsWith('cal:'));
    }
  }
});

// ---------- Harness handler ----------

function makeBot() {
  const handlers = { action: [], hears: [], command: [], on: [] };
  const bot = {
    action: (re, h) => handlers.action.push([re, h]),
    hears: (t, h) => handlers.hears.push([t, h]),
    command: (c, h) => handlers.command.push([c, h]),
    on: (ev, h) => handlers.on.push([ev, h]),
  };
  return { bot, handlers };
}

function makeUserCtx(id) {
  const ctx = {
    from: { id },
    state: { employee: { id, status: 'active', is_active: true } },
    message: null,
    match: null,
    replies: [], edits: [], cbs: [],
    reply: null, editMessageText: null, answerCbQuery: null, replyWithDocument: null,
  };
  ctx.reply = async (t, o) => ctx.replies.push({ t, o });
  ctx.editMessageText = async (t, o) => ctx.edits.push({ t, o });
  ctx.answerCbQuery = async (t) => ctx.cbs.push(t);
  ctx.replyWithDocument = async () => { throw new Error('unexpected'); };
  return ctx;
}

async function fireAction(handlers, data, ctx) {
  for (const [re, h] of handlers.action) {
    const m = re.exec(data);
    if (m) { ctx.match = m.slice(); await h(ctx); return true; }
  }
  return false;
}

function setupServices(repoRows) {
  const calls = { created: [], windows: [] };
  return {
    overtimeService: {
      getMonthlyPayroll: async () => ({ text: 'rekap' }),
      exportMonthlyPayroll: async () => ({ buffer: Buffer.alloc(1), filename: 'x.xlsx' }),
      createManualPeriod: async (emp, payload) => {
        const brk = payload.breakMinutes || 0;
        const gross = 180; // ringan: dipakai tes; 3 jam
        calls.created.push(payload);
        return { session: { id: 1 }, actualMinutes: gross - brk, grossMinutes: gross, breakMinutes: brk, dayTotalMinutes: gross - brk };
      },
    },
    employeeService: { requireActiveEmployee: async (tg) => ({ id: tg, status: 'active', is_active: true }) },
    config: { timezone: TZ },
    overtimeRepo: {
      listByEmployee: async () => [],
      listByEmployeeAndWindow: async (...a) => { calls.windows.push(a); return repoRows; },
    },
    calls,
  };
}

const textHandler = (handlers) => handlers.on.find(([e]) => e === 'text')[1];
const startWizard = (handlers, ctx) => handlers.hears.find(([t]) => t === '📝 INPUT LEMBUR')[1](ctx);

// ---------- Alur handler ----------

test('alur: INPUT LEMBUR → hari ini otomatis terpilih → kalender → pilih tanggal → navigasi', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  assert.strictEqual(ctx.replies.length, 1);
  assert.match(ctx.replies[0].t, /Tanggal terpilih: \d{1,2} \w+ \d{4}/);
  const kb = ctx.replies[0].o.reply_markup.inline_keyboard;
  assert.ok(kb.some((r) => r[0].callback_data === 'cal:open'));

  // Buka kalender (edit pesan wizard).
  await fireAction(handlers, 'cal:open', ctx);
  assert.ok(ctx.edits.some((e) => /Pilih tanggal lembur/.test(e.t)));

  // Pilih tanggal 15 bulan berjalan via callback.
  const today = todayInTz(TZ);
  const day15 = `${today.y}-${String(today.m).padStart(2, '0')}-15`;
  ctx.edits.length = 0;
  await fireAction(handlers, `cal:sel:${day15}`, ctx);
  assert.ok(ctx.edits.length && /Langkah 2\/3/.test(ctx.edits[ctx.edits.length - 1].t) && /15/.test(ctx.edits[ctx.edits.length - 1].t));

  // Navigasi bulan antar tahun: callback membawa bulan target.
  ctx.edits.length = 0;
  await fireAction(handlers, 'cal:next:2026-12', ctx);
  assert.ok(ctx.edits.some((e) => /Desember 2026/.test(e.t)));
  ctx.edits.length = 0;
  await fireAction(handlers, 'cal:prev:2027-01', ctx);
  assert.ok(ctx.edits.some((e) => /Januari 2027/.test(e.t)));

  // Tombol Hari Ini kembali ke hari ini (Taipei).
  ctx.edits.length = 0;
  await fireAction(handlers, 'cal:today', ctx);
  assert.ok(ctx.edits[ctx.edits.length - 1].t.includes(formatDateId(today)));
});

test('tanggal hari ini mengikuti Asia/Taipei saat midnight rollover', () => {
  // 2026-10-11T16:30:00Z = 12 Okt 00:30 Taipei, 11 Okt UTC → cek via format tanggal sistem.
  const p = require('../src/utils/date-time').toZonedParts(new Date('2026-10-11T16:30:00Z'), TZ);
  assert.strictEqual(p.date, '2026-10-12');
});

test('tanggal masa depan: aturan lama dipertahankan (diperbolehkan, tidak diblokir diam-diam)', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  await fireAction(handlers, 'cal:sel:2099-12-31', ctx);
  assert.ok(ctx.edits.some((e) => /31 Desember 2099/.test(e.t) && /Langkah 2\/3/.test(e.t)));
});

test('callback pengguna lain / sesi kedaluwarsa ditolak dengan pesan ramah', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const outsider = makeUserCtx(7);
  await fireAction(handlers, 'cal:sel:2026-10-15', outsider);
  assert.ok(outsider.cbs.some((t) => /kedaluwarsa|berakhir/i.test(t)));
  assert.strictEqual(outsider.edits.length, 0);
  // Wizard pengguna 42 tidak terganggu.
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  await fireAction(handlers, 'cal:sel:2026-10-15', ctx);
  assert.ok(ctx.edits.some((e) => /Langkah 2\/3/.test(e.t)));
});

test('callback kalender saat langkah konfirmasi ditolak (tidak mengganggu wizard)', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('18:00');
  await send('21:00'); // → step break (pilih istirahat)
  assert.ok(ctx.replies.some((r) => /Durasi kotor/.test(r.t)));
  ctx.cbs.length = 0;
  await fireAction(handlers, 'brk:0', ctx); // pilih 0 menit → step confirm
  assert.ok(ctx.replies.some((r) => /Ringkasan input lembur/.test(r.t)));
  ctx.cbs.length = 0;
  await fireAction(handlers, 'cal:sel:2026-10-15', ctx);
  assert.ok(ctx.cbs.some((t) => /selesai|batal/i.test(t)));
  ctx.replies.length = 0;
  await send('ya');
  assert.strictEqual(services.calls.created.length, 1);
});

test('callback tanggal tidak mungkin (cal:sel:2026-02-30) ditolak', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  ctx.cbs.length = 0;
  await fireAction(handlers, 'cal:sel:2026-02-30', ctx);
  assert.ok(ctx.cbs.some((t) => /tidak valid/i.test(t)));
});

test('tombol Batal kalender & /batal tetap bekerja', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  await fireAction(handlers, 'cal:cancel', ctx);
  assert.ok(ctx.edits.some((e) => /dibatalkan/i.test(e.t)));
  ctx.cbs.length = 0;
  await fireAction(handlers, 'cal:open', ctx);
  assert.ok(ctx.cbs.some((t) => /kedaluwarsa|berakhir/i.test(t)));

  const ctx2 = makeUserCtx(43);
  await startWizard(handlers, ctx2);
  const cmd = handlers.command.find(([c]) => c === 'batal');
  await cmd[1](ctx2);
  assert.ok(ctx2.replies.some((r) => /dibatalkan/.test(r.t)));
  const ctx3 = makeUserCtx(43);
  await cmd[1](ctx3);
  assert.ok(ctx3.replies.some((r) => /Tidak ada input/.test(r.t)));
});

test('jam lintas tengah malam + simpan tetap bekerja (tanggal dari kalender)', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  await fireAction(handlers, 'cal:sel:2026-10-15', ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('23:00');
  await send('01:30'); // lintas tengah malam → konfirmasi lintas hari
  assert.ok(ctx.replies.some((r) => /hari berikutnya/.test(r.t)));
  ctx.replies.length = 0;
  await send('ya'); // konfirmasi lintas hari → pilihan istirahat
  assert.ok(ctx.replies.some((r) => /Durasi kotor/.test(r.t)));
  await fireAction(handlers, 'brk:0', ctx); // pilih 0 menit → ringkasan
  assert.ok(ctx.replies.some((r) => /Ringkasan input lembur/.test(r.t)));
  ctx.replies.length = 0;
  await send('ya'); // simpan
  assert.strictEqual(services.calls.created.length, 1);
  assert.deepStrictEqual(services.calls.created[0].date, { y: 2026, m: 10, d: 15 });
  assert.ok(ctx.replies.some((r) => /tersimpan/.test(r.t) && /15 Oktober 2026/.test(r.t)));
});

test('peringatan tumpang tindih tetap muncul; simpan tetap bisa', async () => {
  const rows = [{
    id: 9,
    start_at: '2026-10-15T08:00:00+08:00',
    end_at: '2026-10-15T14:00:00+08:00',
  }];
  const { bot, handlers } = makeBot();
  const services = setupServices(rows);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  await fireAction(handlers, 'cal:sel:2026-10-15', ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('13:00');
  await send('15:00');
  await fireAction(handlers, 'brk:0', ctx); // pilih istirahat 0 menit → ringkasan
  assert.ok(ctx.replies.some((r) => /TUMPANG TINDIH/.test(r.t)));
  await send('ya');
  assert.strictEqual(services.calls.created.length, 1);
});

test('payroll & export callback tetap bekerja setelah penambahan kalender', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await fireAction(handlers, 'pay:2026-10', ctx);
  assert.ok(ctx.edits.some((e) => e.t === 'rekap'));
  await fireAction(handlers, 'exp:2026-10', ctx);
  assert.ok(ctx.cbs.length >= 1);
});
