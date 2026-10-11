'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { rowNetMinutes, formatDailyRecap, formatDurationId } = require('../src/services/overtime-input');
const { aggregateMonthly } = require('../src/services/payroll');
const { OvertimeService } = require('../src/services/overtime.service');
const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');

const TZ = 'Asia/Taipei';

// ---------- Modul murni: titik tunggal pengurangan istirahat ----------

test('rowNetMinutes: 07:30–16:30 istirahat 0 = 9 jam (540 menit)', () => {
  const r = { start_at: '2026-10-15T07:30:00+08:00', end_at: '2026-10-15T16:30:00+08:00', break_minutes: 0 };
  const { gross, breakMinutes, net } = rowNetMinutes(r);
  assert.strictEqual(gross, 540);
  assert.strictEqual(net, 540);
  assert.strictEqual(formatDurationId(net), '9 jam');
});

test('rowNetMinutes: istirahat 30 menit = 8,5 jam; 60 menit = 8 jam', () => {
  const base = { start_at: '2026-10-15T07:30:00+08:00', end_at: '2026-10-15T16:30:00+08:00' };
  assert.strictEqual(rowNetMinutes({ ...base, break_minutes: 30 }).net, 510); // 8,5 jam
  assert.strictEqual(rowNetMinutes({ ...base, break_minutes: 60 }).net, 480); // 8 jam
});

test('rowNetMinutes: input manual 45 menit', () => {
  const r = { start_at: '2026-10-15T07:30:00+08:00', end_at: '2026-10-15T16:30:00+08:00', break_minutes: 45 };
  assert.strictEqual(rowNetMinutes(r).net, 495);
  assert.strictEqual(formatDurationId(495), '8 jam 15 menit');
});

test('rowNetMinutes: tanpa break_minutes (data historis) → durasi dipertahankan apa adanya', () => {
  const r = { start_at: '2026-01-05T08:00:00+08:00', end_at: '2026-01-05T12:00:00+08:00' };
  const { gross, breakMinutes, net } = rowNetMinutes(r);
  assert.strictEqual(gross, 240);
  assert.strictEqual(breakMinutes, 0);
  assert.strictEqual(net, 240); // TIDAK diasumsikan istirahat 1 jam
});

test('rekap harian memakai durasi bersih & menampilkan istirahat', () => {
  const rows = [{
    status: 'completed',
    start_at: '2026-10-15T07:30:00+08:00',
    end_at: '2026-10-15T16:30:00+08:00',
    break_minutes: 60,
  }];
  const text = formatDailyRecap(rows, TZ);
  assert.ok(/Durasi: 8 jam/.test(text));
  assert.ok(/istirahat 60 menit/.test(text));
  assert.ok(/Total lembur harian: 8 jam/.test(text));
});

test('aggregateMonthly memakai durasi bersih (K1/K2/K3 dari durasi bersih)', () => {
  const rows = [{
    id: 1, status: 'completed',
    start_at: '2026-10-15T07:30:00+08:00',
    end_at: '2026-10-15T16:30:00+08:00',
    break_minutes: 60,
  }];
  const agg = aggregateMonthly(rows, TZ);
  assert.strictEqual(agg.totals.minutes, 480); // 8 jam, bukan 9 jam
  assert.deepStrictEqual(agg.totals.categories, { 1: 120, 2: 120, 3: 240 });
});

test('aggregateMonthly: baris historis tanpa break_minutes tidak berubah', () => {
  const rows = [{
    id: 2, status: 'completed',
    start_at: '2026-10-16T18:00:00+08:00', end_at: '2026-10-16T21:00:00+08:00',
  }];
  const agg = aggregateMonthly(rows, TZ);
  assert.strictEqual(agg.totals.minutes, 180);
});

test('tidak ada pemotongan otomatis untuk Sabtu, Minggu, maupun tanggal merah apa pun', () => {
  // 2026-10-17 = Sabtu; 2026-10-18 = Minggu. Tidak ada break_minutes → kotor = bersih.
  // Tidak ada modul kalender hari libur di proyek ini; klasifikasi tanggal merah
  // tidak ada sehingga tidak ada pemotongan berbasis hari sama sekali.
  for (const d of ['2026-10-17', '2026-10-18']) {
    const r = { status: 'completed', start_at: `${d}T09:00:00+08:00`, end_at: `${d}T12:00:00+08:00` };
    assert.strictEqual(aggregateMonthly([r], TZ).totals.minutes, 180);
  }
});


// ---------- Service: validasi istirahat & penyimpanan ----------

function makeService(repoRows) {
  const calls = { created: [] };
  const fakeRepo = {
    async listByEmployeeAndWindow() { return repoRows; },
    async createManual(...args) { calls.created.push(args); return 55; },
    async findById() { return { id: 55 }; },
    async withTransaction(fn) { return fn({}); },
  };
  const svc = new OvertimeService({
    overtimeRepo: fakeRepo,
    auditRepo: { async log() {} },
    config: { timezone: TZ, overtime: { minMinutes: 30, roundingMinutes: 15 } },
  });
  return { svc, calls };
}

const INPUT = {
  date: { y: 2026, m: 10, d: 15 },
  start: { h: 7, min: 30 },
  end: { h: 16, min: 30 },
};

test('service: istirahat 60 → actual/payable dari durasi bersih, break tersimpan eksplisit', async () => {
  const { svc, calls } = makeService([]);
  const res = await svc.createManualPeriod({ id: 1, telegram_user_id: 42 }, { ...INPUT, breakMinutes: 60 });
  assert.strictEqual(res.actualMinutes, 480);
  assert.strictEqual(res.grossMinutes, 540);
  assert.strictEqual(res.breakMinutes, 60);
  const args = calls.created[0];
  assert.strictEqual(args[3], 480); // actual_minutes = bersih
  assert.strictEqual(args[4], 480); // payable_minutes = bersih (pembulatan 15)
  assert.strictEqual(args[7], 60);  // break_minutes eksplisit
});

test('service: istirahat melebihi durasi kotor / bersih nol ditolak', async () => {
  const { svc } = makeService([]);
  await assert.rejects(
    () => svc.createManualPeriod({ id: 1, telegram_user_id: 42 }, { ...INPUT, breakMinutes: 540 }),
    /kurang dari durasi kotor/
  );
  await assert.rejects(
    () => svc.createManualPeriod({ id: 1, telegram_user_id: 42 }, { ...INPUT, breakMinutes: 600 }),
    /kurang dari durasi kotor/
  );
  await assert.rejects(
    () => svc.createManualPeriod({ id: 1, telegram_user_id: 42 }, {
      date: { y: 2026, m: 10, d: 15 }, start: { h: 8, min: 0 }, end: { h: 9, min: 0 }, breakMinutes: 60,
    }),
    /kurang dari durasi kotor/
  );
});

test('service: lembur lintas tengah malam + istirahat manual 45 menit', async () => {
  const { svc, calls } = makeService([]);
  const res = await svc.createManualPeriod({ id: 1, telegram_user_id: 42 }, {
    date: { y: 2026, m: 10, d: 15 },
    start: { h: 22, min: 0 },
    end: { h: 3, min: 0 },
    crossMidnight: true,
    breakMinutes: 45,
  });
  assert.strictEqual(res.grossMinutes, 300);
  assert.strictEqual(res.actualMinutes, 255);
  assert.strictEqual(calls.created[0][7], 45);
});

test('service: lembur pendek tanpa istirahat — payable null di bawah minimum', async () => {
  const { svc } = makeService([]);
  const res = await svc.createManualPeriod({ id: 1, telegram_user_id: 42 }, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 18, min: 0 }, end: { h: 18, min: 20 }, breakMinutes: 0,
  });
  assert.strictEqual(res.actualMinutes, 20);
  assert.strictEqual(res.payableMinutes, null);
});

test('service: total harian memakai bersih dari baris lama yang punya break_minutes', async () => {
  const old = {
    id: 9, status: 'completed',
    start_at: '2026-10-15T08:00:00+08:00', end_at: '2026-10-15T12:00:00+08:00',
    break_minutes: 30,
  };
  const { svc } = makeService([old]);
  const res = await svc.createManualPeriod({ id: 1, telegram_user_id: 42 }, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 13, min: 0 }, end: { h: 16, min: 0 }, breakMinutes: 0,
  });
  // 240 - 30 + 180 = 390
  assert.strictEqual(res.dayTotalMinutes, 390);

// ---------- Harness handler: alur wizard istirahat ----------

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
    message: null, match: null,
    replies: [], edits: [], cbs: [],
  };
  ctx.reply = async (t, o) => ctx.replies.push({ t, o });
  ctx.editMessageText = async (t, o) => ctx.edits.push({ t, o });
  ctx.answerCbQuery = async (t) => ctx.cbs.push(t);
  return ctx;
}

async function fireAction(handlers, data, ctx) {
  for (const [re, h] of handlers.action) {
    const m = re.exec(data);
    if (m) { ctx.match = m.slice(); await h(ctx); return true; }
  }
  return false;
}

const textHandler = (handlers) => handlers.on.find(([e]) => e === 'text')[1];
const startWizard = (handlers, ctx) => handlers.hears.find(([t]) => t === '📝 INPUT LEMBUR')[1](ctx);

function setupServices(repoRows) {
  const calls = { created: [], windows: [] };
  return {
    overtimeService: {
      getMonthlyPayroll: async () => ({ text: 'rekap' }),
      exportMonthlyPayroll: async () => ({ buffer: Buffer.alloc(1), filename: 'x.xlsx' }),
      createManualPeriod: async (emp, payload) => {
        const brk = payload.breakMinutes || 0;

test('wizard: 07:30–16:30 → durasi kotor 9 jam → istirahat 60 → bersih 8 jam di ringkasan', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('07:30');
  await send('16:30');
  assert.ok(ctx.replies.some((r) => /Durasi kotor: 9 jam/.test(r.t)));
  const kbMsg = ctx.replies.find((r) => r.o && r.o.reply_markup);
  const flat = kbMsg.o.reply_markup.inline_keyboard.flat();
  assert.deepStrictEqual(flat.map((b) => b.callback_data), ['brk:0', 'brk:30', 'brk:45', 'brk:60', 'brk:custom', 'brk:cancel']);
  await fireAction(handlers, 'brk:60', ctx);
  const summary = ctx.replies.find((r) => /Ringkasan input lembur/.test(r.t));
  assert.ok(/Durasi kotor: 9 jam/.test(summary.t));
  assert.ok(/Istirahat: 1 jam/.test(summary.t));
  assert.ok(/Durasi bersih: 8 jam/.test(summary.t));
  ctx.replies.length = 0;
  await send('ya');
  assert.strictEqual(services.calls.created.length, 1);
  assert.strictEqual(services.calls.created[0].breakMinutes, 60);
  assert.ok(ctx.replies.some((r) => /tersimpan/.test(r.t) && /Durasi bersih: 8 jam/.test(r.t)));
});

test('wizard: istirahat 0 menit = 9 jam bersih (default, tanpa pemotongan otomatis)', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('07:30');
  await send('16:30');
  await fireAction(handlers, 'brk:0', ctx);
  const summary = ctx.replies.find((r) => /Ringkasan input lembur/.test(r.t));
  assert.ok(/Istirahat: 0 menit/.test(summary.t));
  assert.ok(/Durasi bersih: 9 jam/.test(summary.t));
  await send('ya');
  assert.strictEqual(services.calls.created[0].breakMinutes, 0);
});

test('wizard: istirahat 30 menit → bersih 8,5 jam', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('07:30');
  await send('16:30');
  await fireAction(handlers, 'brk:30', ctx);
  const summary = ctx.replies.find((r) => /Ringkasan input lembur/.test(r.t));
  assert.ok(/Durasi bersih: 8 jam 30 menit/.test(summary.t));
});

test('wizard: input manual 45 menit via tombol custom + teks', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('07:30');
  await send('16:30');
  await fireAction(handlers, 'brk:custom', ctx);
  assert.ok(ctx.replies.some((r) => /jumlah menit istirahat/i.test(r.t)));
  await send('empat puluh lima');
  assert.ok(ctx.replies.some((r) => /bilangan bulat/i.test(r.t)));

test('wizard: istirahat melebihi durasi kotor ditolak, wizard tetap hidup', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('18:00');
  await send('19:00'); // kotor 60 menit
  await fireAction(handlers, 'brk:60', ctx); // bersih 0 → ditolak
  assert.ok(ctx.replies.some((r) => /tidak boleh 0 atau negatif/.test(r.t)));
  await fireAction(handlers, 'brk:custom', ctx);
  await send('90'); // melebihi kotor
  assert.ok(ctx.replies.some((r) => /melebihi durasi kotor/.test(r.t)));
  await fireAction(handlers, 'brk:30', ctx); // valid → ringkasan
  assert.ok(ctx.replies.some((r) => /Ringkasan input lembur/.test(r.t)));
});

test('wizard: lembur pendek tanpa istirahat (20 menit) tersimpan bersih', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('18:00');
  await send('18:20');
  await fireAction(handlers, 'brk:0', ctx);
  await send('ya');
  assert.strictEqual(services.calls.created[0].breakMinutes, 0);
});

test('wizard: tombol brk: pengguna lain / langkah lain ditolak ramah', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const outsider = makeUserCtx(7);
  await fireAction(handlers, 'brk:60', outsider);
  assert.ok(outsider.cbs.some((t) => /kedaluwarsa|berakhir/i.test(t)));
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  await fireAction(handlers, 'brk:60', ctx); // langkah start, bukan break
  assert.ok(ctx.cbs.some((t) => /istirahat sudah selesai|batal/i.test(t)));
});

test('wizard: tombol Batal istirahat & /batal di langkah break', async () => {
  const { bot, handlers } = makeBot();
  const services = setupServices([]);
  registerOvertimeHandlers(bot, services);
  const ctx = makeUserCtx(42);
  await startWizard(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await send('07:30');
  await send('16:30');
  await fireAction(handlers, 'brk:cancel', ctx);
  assert.ok(ctx.replies.some((r) => /dibatalkan/.test(r.t)));
  await startWizard(handlers, ctx);
  await send('07:30');
  await send('16:30');
  await send('/batal');
  assert.ok(ctx.replies.some((r) => /dibatalkan/.test(r.t)));
});
  await send('45');
  const summary = ctx.replies.find((r) => /Ringkasan input lembur/.test(r.t));
  assert.ok(/Istirahat: 45 menit/.test(summary.t));
  assert.ok(/Durasi bersih: 8 jam 15 menit/.test(summary.t));
  await send('ya');
  assert.strictEqual(services.calls.created[0].breakMinutes, 45);
});
        const gross = payload.end.h * 60 + payload.end.min - (payload.start.h * 60 + payload.start.min);
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
});