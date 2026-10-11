'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { OvertimeService } = require('../src/services/overtime.service');
const { aggregateMonthly } = require('../src/services/payroll');
const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');

const TZ = 'Asia/Taipei';

// ---------- Harness: fake repo + service nyata ----------

/** Baris contoh: karyawan id 7 (telegram 42), 15 Okt 2026 07:30–16:30 Taipei, istirahat 60. */
function baseRow(overrides = {}) {
  return {
    id: 12, employee_id: 7, status: 'completed',
    start_at: '2026-10-15T07:30:00+08:00',
    end_at: '2026-10-15T16:30:00+08:00',
    break_minutes: 60, actual_minutes: 480, payable_minutes: 480,
    note: 'input manual 15-10-2026',
    ...overrides,
  };
}

function makeRepo(rows) {
  const state = { rows: rows.map((r) => ({ ...r })), updated: [], audits: [] };
  const repo = {
    state,
    async findById(id, conn) {
      if (conn && repo._txRowOverride) return repo._txRowOverride(id);
      return state.rows.find((r) => r.id === id) || null;
    },
    async listByEmployee(empId) { return state.rows.filter((r) => r.employee_id === empId); },
    async listByEmployeeAndWindow(empId, ws, we) {
      return state.rows.filter((r) => r.employee_id === empId && r.status !== 'active'
        && new Date(r.start_at) < we && (r.end_at === null || new Date(r.end_at) > ws));
    },
    async updateManual(id, startAt, endAt, actual, payable, brk) {
      const row = state.rows.find((r) => r.id === id);
      if (!row) return false;
      Object.assign(row, { start_at: startAt, end_at: endAt, actual_minutes: actual, payable_minutes: payable, break_minutes: brk });
      state.updated.push({ id, startAt, endAt, actual, payable, brk });
      return true;
    },
    async withTransaction(fn) { return fn({}); },
  };
  return repo;
}

function makeService(repo, { txRowOverride } = {}) {
  if (txRowOverride) repo._txRowOverride = txRowOverride;
  const svc = new OvertimeService({
    overtimeRepo: repo,
    auditRepo: {
      async log(actor, action, type, id, detail, conn) {
        repo.state.audits.push({ actor, action, type, id, detail });
      },
    },
    config: { timezone: TZ, overtime: { minMinutes: 30, roundingMinutes: 15 } },
  });
  return svc;
}

const EMP = { id: 7, telegram_user_id: 42 };
const NEW = { date: { y: 2026, m: 10, d: 15 }, start: { h: 8, min: 0 }, end: { h: 17, min: 0 }, breakMinutes: 30 };

// ---------- Service: edit jam mulai/selesai & istirahat ----------

test('service: edit jam mulai/selesai → durasi & payable dihitung ulang dari tanggal+jam', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo);
  const res = await svc.updateManualPeriod(EMP, 12, NEW, { force: true });
  assert.strictEqual(res.grossMinutes, 540);
  assert.strictEqual(res.breakMinutes, 30);
  assert.strictEqual(res.actualMinutes, 510);
  assert.strictEqual(res.payableMinutes, 510);
  const u = repo.state.updated[0];
  assert.strictEqual(u.brk, 30);
  assert.strictEqual(new Date(u.startAt).getTime(), new Date('2026-10-15T08:00:00+08:00').getTime());
  // Baris tersimpan benar-benar berubah:
  const row = repo.state.rows.find((r) => r.id === 12);
  assert.strictEqual(row.actual_minutes, 510);
  assert.strictEqual(row.break_minutes, 30);
});

test('service: audit mencatat identitas, ID catatan, dan nilai sebelum/sesudah', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo);
  await svc.updateManualPeriod(EMP, 12, NEW, { force: true });
  const a = repo.state.audits.find((x) => x.action === 'overtime.edit');
  assert.ok(a, 'audit overtime.edit ada');
  assert.strictEqual(a.actor, 42);
  assert.strictEqual(a.id, 12);
  assert.match(a.detail, /sebelum=/);
  assert.match(a.detail, /sesudah=/);
  assert.match(a.detail, /"break_minutes":60/);
  assert.match(a.detail, /"break_minutes":30/);
  assert.ok(!/token|password|credential/i.test(a.detail));
});

for (const brk of [0, 30, 45, 60]) {
  test(`service: edit istirahat menjadi ${brk} menit tersimpan & bersih = kotor − ${brk}`, async () => {
    const repo = makeRepo([baseRow({ break_minutes: 0 })]);
    const svc = makeService(repo);
    const res = await svc.updateManualPeriod(EMP, 12, {
      date: { y: 2026, m: 10, d: 15 }, start: { h: 7, min: 30 }, end: { h: 16, min: 30 }, breakMinutes: brk,
    }, { force: true });
    assert.strictEqual(res.grossMinutes, 540);
    assert.strictEqual(res.actualMinutes, 540 - brk);
    assert.strictEqual(repo.state.rows.find((r) => r.id === 12).break_minutes, brk);
  });
}

test('service: istirahat manual 45 menit via input bebas', async () => {
  const repo = makeRepo([baseRow({ break_minutes: 0 })]);
  const svc = makeService(repo);
  const res = await svc.updateManualPeriod(EMP, 12, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 7, min: 30 }, end: { h: 16, min: 30 }, breakMinutes: 45,
  }, { force: true });
  assert.strictEqual(res.actualMinutes, 495);
});

test('service: istirahat sama dengan / melebihi durasi kotor ditolak, data tidak berubah', async () => {
  const repo = makeRepo([baseRow({ break_minutes: 0 })]);
  const svc = makeService(repo);
  const input = { date: { y: 2026, m: 10, d: 15 }, start: { h: 7, min: 30 }, end: { h: 16, min: 30 } };
  await assert.rejects(() => svc.updateManualPeriod(EMP, 12, { ...input, breakMinutes: 540 }, { force: true }), /kurang dari durasi kotor/);
  await assert.rejects(() => svc.updateManualPeriod(EMP, 12, { ...input, breakMinutes: 600 }, { force: true }), /kurang dari durasi kotor/);
  assert.strictEqual(repo.state.updated.length, 0);
});

test('service: edit lintas tengah malam (22:00 → 03:00) dihitung benar', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo);
  const res = await svc.updateManualPeriod(EMP, 12, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 22, min: 0 }, end: { h: 3, min: 0 },
    crossMidnight: true, breakMinutes: 45,
  }, { force: true });
  assert.strictEqual(res.grossMinutes, 300);
  assert.strictEqual(res.actualMinutes, 255);
});

// ---------- Service: keamanan, status, duplikat, tumpang tindih ----------

test('service: pengguna lain tidak dapat mengedit catatan milik orang lain', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo);
  await assert.rejects(
    () => svc.updateManualPeriod({ id: 8, telegram_user_id: 99 }, 12, NEW, { force: true }),
    /milik Anda sendiri/
  );
  assert.strictEqual(repo.state.updated.length, 0);
  assert.strictEqual(repo.state.audits.filter((a) => a.action === 'overtime.edit').length, 0);
});

test('service: catatan rejected / approved / active tidak dapat diedit', async () => {
  for (const status of ['rejected', 'approved', 'active']) {
    const repo = makeRepo([baseRow({ status })]);
    const svc = makeService(repo);
    await assert.rejects(() => svc.updateManualPeriod(EMP, 12, NEW, { force: true }), /tidak dapat diedit/);
    assert.strictEqual(repo.state.updated.length, 0, `tidak ada UPDATE untuk status ${status}`);
  }
});

test('service: status berubah menjadi tidak-editable sebelum penyimpanan → dibatalkan di dalam transaksi', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo, {
    txRowOverride: () => baseRow({ status: 'approved' }), // dibaca ulang dalam transaksi
  });
  await assert.rejects(() => svc.updateManualPeriod(EMP, 12, NEW, { force: true }), /Status catatan berubah/);
  assert.strictEqual(repo.state.updated.length, 0);
  assert.strictEqual(repo.state.audits.filter((a) => a.action === 'overtime.edit').length, 0);
});

test('service: catatan hilang / ID palsu ditolak', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo);
  await assert.rejects(() => svc.updateManualPeriod(EMP, 999, NEW, { force: true }), /tidak ditemukan/);
  await assert.rejects(() => svc.updateManualPeriod(EMP, '12; DROP TABLE', NEW, { force: true }), /ID catatan tidak valid/);
  assert.strictEqual(repo.state.updated.length, 0);
});

test('service: tanggal/jam tidak valid ditolak (format ketat, kalender)', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo);
  await assert.rejects(() => svc.updateManualPeriod(EMP, 12, {
    date: { y: 2026, m: 2, d: 31 }, start: { h: 8, min: 0 }, end: { h: 17, min: 0 }, breakMinutes: 30,
  }, { force: true }));
  await assert.rejects(() => svc.updateManualPeriod(EMP, 12, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 25, min: 0 }, end: { h: 17, min: 0 }, breakMinutes: 30,
  }, { force: true }));
  await assert.rejects(() => svc.updateManualPeriod(EMP, 12, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 9, min: 0 }, end: { h: 9, min: 0 }, breakMinutes: 0,
  }, { force: true }));
  assert.strictEqual(repo.state.updated.length, 0);
});

test('service: duplikat identik dengan catatan LAIN ditolak; catatan sendiri dikecualikan', async () => {
  const repo = makeRepo([baseRow({ break_minutes: 0 }), baseRow({ id: 13, break_minutes: 0 })]);
  const svc = makeService(repo);
  // Edit #12 menjadi identik dengan #13 → ditolak.
  await assert.rejects(
    () => svc.updateManualPeriod(EMP, 12, {
      date: { y: 2026, m: 10, d: 15 }, start: { h: 7, min: 30 }, end: { h: 16, min: 30 }, breakMinutes: 0,
    }, { force: true }),
    /identik/
  );
  // Edit #13 ke rentang berbeda (diri sendiri bukan duplikat) → berhasil.
  await svc.updateManualPeriod(EMP, 13, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 18, min: 0 }, end: { h: 20, min: 0 }, breakMinutes: 0,
  }, { force: true });
  assert.ok(repo.state.updated.some((u) => u.id === 13));
});

test('service: tumpang tindih → needsConfirm tanpa menulis; force=true menulis', async () => {
  const repo = makeRepo([baseRow({ break_minutes: 0 }), baseRow({ id: 13, break_minutes: 0 })]);
  const svc = makeService(repo);
  // Edit #13 menjadi 08:00–10:00 (tumpang tindih #12 07:30–16:30).
  const res = await svc.updateManualPeriod(EMP, 13, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 8, min: 0 }, end: { h: 10, min: 0 }, breakMinutes: 0,
  });
  assert.strictEqual(res.needsConfirm, true);
  assert.strictEqual(res.overlapping.length, 1);
  assert.strictEqual(repo.state.updated.length, 0);
  const res2 = await svc.updateManualPeriod(EMP, 13, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 8, min: 0 }, end: { h: 10, min: 0 }, breakMinutes: 0,
  }, { force: true });
  assert.ok(!res2.needsConfirm);
  assert.ok(repo.state.updated.some((u) => u.id === 13));
});


// ---------- Handler: alur Edit via Telegram ----------

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

function makeCtx(id) {
  const ctx = { from: { id }, message: null, match: null, replies: [], edits: [], cbs: [] };
  ctx.reply = async (t, o) => ctx.replies.push({ t, o });
  ctx.editMessageText = async (t, o) => ctx.edits.push({ t, o });
  ctx.answerCbQuery = async (t) => ctx.cbs.push(t || '');
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

function setup(rows) {
  const repo = makeRepo(rows);
  const svc = new OvertimeService({
    overtimeRepo: repo,
    auditRepo: { async log(a, act, t, id, d) { repo.state.audits.push({ actor: a, action: act, type: t, id, detail: d }); } },
    config: { timezone: TZ, overtime: { minMinutes: 30, roundingMinutes: 15 } },
  });
  const { bot, handlers } = makeBot();
  registerOvertimeHandlers(bot, {
    overtimeService: svc,
    employeeService: { requireActiveEmployee: async (tg) => (tg === 42 ? EMP : null) },
    config: { timezone: TZ },
    overtimeRepo: repo,
  });
  return { repo, svc, handlers };
}

async function openEdit(handlers, ctx, rowId = 12) {
  await fireAction(handlers, `ed:view:${rowId}`, ctx);
  await fireAction(handlers, `ed:edit:${rowId}`, ctx);
}

test('handler: riwayat ber-paginasi dengan tombol detail ed:view (prefix ed: unik)', async () => {
  const { handlers } = setup(Array.from({ length: 12 }, (_, i) => baseRow({
    id: i + 1,
    start_at: `2026-10-${String(1 + i).padStart(2, '0')}T07:30:00+08:00`,
    end_at: `2026-10-${String(1 + i).padStart(2, '0')}T16:30:00+08:00`,
  })));
  const ctx = makeCtx(42);
  const hist = handlers.hears.find(([t]) => t === '📁 Riwayat Lembur')[1];
  await hist(ctx);
  const msg = ctx.replies.find((r) => r.o && r.o.reply_markup);
  assert.ok(msg, 'keyboard pagination ada');
  const flat = msg.o.reply_markup.inline_keyboard.flat();
  assert.ok(flat.length >= 6); // 5 baris + navigasi
  assert.ok(flat.every((b) => !b.callback_data.startsWith('cal:') && !b.callback_data.startsWith('brk:')
    && !b.callback_data.startsWith('pay:') && !b.callback_data.startsWith('exp:')));
  // Halaman 2:
  const ctx2 = makeCtx(42);
  await fireAction(handlers, 'ed:page:1', ctx2);
  const msg2 = ctx2.edits[0] || ctx2.replies[0];
  assert.ok(/Hal\. 2\/3/.test(msg2.t) || /Hal\. 2\/3/.test(JSON.stringify(msg2.o)));
});

test('handler: edit jam mulai & selesai → ringkasan lama→baru → simpan → durasi baru', async () => {
  const { handlers, repo } = setup([baseRow()]);
  const ctx = makeCtx(42);
  await openEdit(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await fireAction(handlers, 'ed:f:start', ctx);
  await send('08:00');
  await fireAction(handlers, 'ed:f:end', ctx);
  await send('17:00');
  await fireAction(handlers, 'ed:review', ctx);
  const summary = ctx.replies.find((r) => /Ringkasan perubahan/.test(r.t));
  assert.ok(/Mulai: 07:30 → 08:00/.test(summary.t));
  assert.ok(/Selesai: 16:30 → 17:00/.test(summary.t));
  assert.ok(/• Durasi kotor: 9 jam\n/.test(summary.t)); // nilai sama → tanpa panah
  assert.ok(!/Durasi kotor:.*→/.test(summary.t));
  assert.ok(/• Durasi bersih: 8 jam\n/.test(summary.t)); // bersih tetap 540−60=480
  assert.ok(!/Durasi bersih:.*→/.test(summary.t));
  await fireAction(handlers, 'ed:save', ctx);
  const done = ctx.replies.find((r) => /tersimpan/.test(r.t));
  assert.ok(/Durasi bersih: 8 jam\n/.test(done.t));
  assert.strictEqual(repo.state.updated.length, 1);
  const audit = repo.state.audits.find((a) => a.action === 'overtime.edit');
  assert.ok(audit && /sebelum=.*sesudah=/.test(audit.detail));
});

test('handler: edit tanggal via kalender → menu memakai tanggal baru', async () => {
  const { handlers, repo } = setup([baseRow()]);
  const ctx = makeCtx(42);
  await openEdit(handlers, ctx);
  await fireAction(handlers, 'ed:f:date', ctx);
  // Pilih 16-10-2026 di kalender:
  await fireAction(handlers, 'cal:sel:2026-10-16', ctx);
  const menu = ctx.edits.findLast((m) => /Edit catatan lembur #12/.test(m.t));
  assert.ok(/• Tanggal: 16 Oktober 2026/.test(menu.t), 'menu menampilkan tanggal baru');
  await fireAction(handlers, 'ed:review', ctx);
  await fireAction(handlers, 'ed:save', ctx);
  const u = repo.state.updated[0];
  assert.strictEqual(new Date(u.startAt).getTime(), new Date('2026-10-16T07:30:00+08:00').getTime());
});

test('handler: edit istirahat 0/30/45/60 dan manual via ed:b:', async () => {
  const { handlers } = setup([baseRow()]);
  for (const [v, label] of [['0', '0 menit'], ['30', '30 menit'], ['45', '45 menit'], ['60', '1 jam']]) {
    const c = makeCtx(42);
    await openEdit(handlers, c);
    await fireAction(handlers, 'ed:f:brk', c);
    await fireAction(handlers, `ed:b:${v}`, c);
    const menu = c.edits.findLast((m) => /Edit catatan lembur #12/.test(m.t));
    assert.ok(new RegExp(`• Istirahat: ${label}`).test(menu.t), `istirahat ${v} menit di menu`);
  }
  // Manual 40 via teks:
  const c = makeCtx(42);
  await openEdit(handlers, c);
  await fireAction(handlers, 'ed:f:brk', c);
  await fireAction(handlers, 'ed:b:custom', c);
  c.message = { text: 'empat puluh' };
  await textHandler(handlers)(c);
  assert.ok(c.replies.some((r) => /bilangan bulat/.test(r.t)));
  c.message = { text: '40' };
  await textHandler(handlers)(c);
  const menu = c.edits.findLast((m) => /Edit catatan lembur #12/.test(m.t));
  assert.ok(/• Istirahat: 40 menit/.test(menu.t));
});

test('handler: istirahat melebihi durasi kotor ditolak di wizard', async () => {
  const { handlers, repo } = setup([baseRow({ break_minutes: 0 })]);
  const ctx = makeCtx(42);
  await openEdit(handlers, ctx);
  await fireAction(handlers, 'ed:f:brk', ctx);
  await fireAction(handlers, 'ed:b:custom', ctx);
  ctx.message = { text: '540' };
  await textHandler(handlers)(ctx);
  assert.ok(ctx.replies.some((r) => /melebihi atau sama dengan durasi kotor/.test(r.t)));
  assert.strictEqual(repo.state.updated.length, 0);
});

test('handler: jam selesai < mulai → konfirmasi lintas tengah malam (ya/tidak)', async () => {
  const { handlers, repo } = setup([baseRow()]);
  const ctx = makeCtx(42);
  await openEdit(handlers, ctx);
  const send = async (t) => { ctx.message = { text: t }; await textHandler(handlers)(ctx); };
  await fireAction(handlers, 'ed:f:start', ctx);
  await send('22:00');
  await fireAction(handlers, 'ed:f:end', ctx);
  await send('03:00');
  assert.ok(ctx.replies.some((r) => /hari berikutnya\? Balas "ya" atau "tidak"/.test(r.t)));
  await send('mungkin');
  assert.ok(ctx.replies.some((r) => /Balas "ya" atau "tidak"/.test(r.t)));
  await send('ya');
  const menu = ctx.edits.findLast((m) => /Edit catatan lembur #12/.test(m.t));
  assert.ok(/Selesai: 03:00 \(hari berikutnya\)/.test(menu.t));
  await fireAction(handlers, 'ed:review', ctx);
  await fireAction(handlers, 'ed:save', ctx);
  assert.strictEqual(new Date(repo.state.updated[0].endAt).getTime(), new Date('2026-10-16T03:00:00+08:00').getTime());
});

test('handler: format jam tidak valid ditolak, wizard tetap hidup', async () => {
  const { handlers, repo } = setup([baseRow()]);
  const ctx = makeCtx(42);
  await openEdit(handlers, ctx);
  await fireAction(handlers, 'ed:f:start', ctx);
  ctx.message = { text: '8:0' };
  await textHandler(handlers)(ctx);
  assert.ok(ctx.replies.some((r) => /Format jam harus HH:MM/.test(r.t)));
  ctx.message = { text: 'abc' };
  await textHandler(handlers)(ctx);
  assert.ok(ctx.replies.some((r) => /Format jam harus HH:MM/.test(r.t)));
  assert.strictEqual(repo.state.updated.length, 0);
});

test('handler: /batal membatalkan edit; sesi edit kedaluwarsa menolak callback; status berubah → simpan ditolak', async () => {
  const { handlers, repo } = setup([baseRow()]);
  // /batal via command tanpa sesi:
  const ctx0 = makeCtx(42);
  await handlers.command.find(([c]) => c === 'batal')[1](ctx0);
  assert.ok(ctx0.replies.some((r) => /Tidak ada input lembur yang sedang berjalan/.test(r.t)));
  // Callback ed:* tanpa sesi → pesan kedaluwarsa:
  const ctx = makeCtx(42);
  await fireAction(handlers, 'ed:f:brk', ctx);
  assert.ok(ctx.cbs.some((t) => /kedaluwarsa/.test(t)));
  await fireAction(handlers, 'ed:save', ctx);
  assert.ok(ctx.cbs.some((t) => /tidak valid/.test(t)));
  // Edit dibuka lalu /batal:
  await openEdit(handlers, ctx);
  ctx.message = { text: '/batal' };
  await textHandler(handlers)(ctx);
  assert.ok(ctx.replies.some((r) => /Edit lembur dibatalkan/.test(r.t)));
  await fireAction(handlers, 'ed:review', ctx);
  assert.ok(ctx.cbs.some((t) => /kedaluwarsa/.test(t)));
  assert.strictEqual(repo.state.updated.length, 0);
  // Status berubah sebelum simpan (approved): ed:save gagal, tidak ada UPDATE.
  const repo2rows = () => makeRepo([baseRow()]);
  const { handlers: h2, repo: r2 } = setup([baseRow()]);
  r2._txRowOverride = () => baseRow({ status: 'approved' });
  const ctx2 = makeCtx(42);
  await openEdit(h2, ctx2);
  await fireAction(h2, 'ed:review', ctx2);
  await fireAction(h2, 'ed:save', ctx2);
  assert.ok(ctx2.replies.some((r) => /Gagal menyimpan perubahan/.test(r.t)));
  assert.strictEqual(r2.state.updated.length, 0);
  void repo2rows;
});

test('handler: catatan approved tidak menampilkan tombol Edit di detail', async () => {
  const { handlers } = setup([baseRow({ status: 'approved' })]);
  const ctx = makeCtx(42);
  await fireAction(handlers, 'ed:view:12', ctx);
  const kb = JSON.stringify(ctx.edits[0].o);
  assert.ok(!/ed:edit:12/.test(kb));
  assert.ok(/tidak dapat diedit/.test(ctx.edits[0].t));
});

test('payroll & Excel: hasil edit terbaca rekap bulanan & Excel tanpa pengurangan ganda', async () => {
  const repo = makeRepo([baseRow()]);
  const svc = makeService(repo);
  // Sebelum edit: kotor 540, istirahat 60, bersih 480.
  const before = await svc.getMonthlyPayroll(EMP, 2026, 10);
  assert.strictEqual(before.aggregate.totals.minutes, 480);
  // Edit: istirahat 30 (bersih 510).
  await svc.updateManualPeriod(EMP, 12, {
    date: { y: 2026, m: 10, d: 15 }, start: { h: 7, min: 30 }, end: { h: 16, min: 30 }, breakMinutes: 30,
  }, { force: true });
  const after = await svc.getMonthlyPayroll(EMP, 2026, 10);
  assert.strictEqual(after.aggregate.totals.minutes, 510);
  const a2 = aggregateMonthly(repo.state.rows, TZ);
  assert.strictEqual(a2.totals.minutes, 510);
  void repo;
});

test('handler: ed:view → detail; ed:edit → menu; pengguna lain ditolak; callback palsu diabaikan', async () => {
  const { handlers } = setup([baseRow()]);
  const ctx = makeCtx(42);
  await openEdit(handlers, ctx);
  const detail = ctx.edits[0];
  assert.ok(/Detail catatan lembur #12/.test(detail.t));
  assert.ok(/Istirahat: 1 jam/.test(detail.t));
  const menu = ctx.edits[1];
  assert.ok(/Edit catatan lembur #12/.test(menu.t));
  assert.ok(/• Mulai: 07:30/.test(menu.t));

  const outsider = makeCtx(99);
  await fireAction(handlers, 'ed:view:12', outsider);
  assert.ok(outsider.cbs.some((t) => /bukan milik|Gagal memuat|tidak aktif/.test(t)));
  const outsider2 = makeCtx(99);
  await fireAction(handlers, 'ed:edit:12', outsider2);
  assert.ok(outsider2.cbs.some((t) => /bukan milik|Gagal membuka|tidak aktif/.test(t)));
  // Callback palsu (tidak terdaftar) tidak melakukan apa pun:
  assert.strictEqual(await fireAction(handlers, 'ed:evil:1;DROP', makeCtx(42)), false);
});
