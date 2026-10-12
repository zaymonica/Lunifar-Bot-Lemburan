'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildHistoryRows, buildHistoryWorkbook, historyFileName, HOUR_FMT } = require('../src/services/history-excel');
const { splitCategories } = require('../src/services/payroll');
const i18n = require('../src/i18n');
const ExcelJS = require('exceljs');

const TZ = 'Asia/Taipei'; // UTC+8, tanpa DST

/** Sesi 15 Okt 2026 07:30–16:30 Taipei (540 menit kotor), istirahat b. */
const row = (id, startISO, endISO, { status = 'completed', breakMinutes = 0 } = {}) => ({
  id, status, start_at: startISO, end_at: endISO, break_minutes: breakMinutes,
});

test('buildHistoryRows: susunan kolom, format DD-MM-YYYY & HH:MM, tanpa kolom keterangan/upah', async () => {
  const rows = [row(1, '2026-10-15T07:30:00+08:00', '2026-10-15T16:30:00+08:00', { breakMinutes: 60 })];
  const data = buildHistoryRows(rows, TZ);
  assert.strictEqual(data.length, 1);
  const d = data[0];
  assert.strictEqual(d.date, '15-10-2026');
  assert.strictEqual(d.start, '07:30');
  assert.strictEqual(d.end, '16:30');
  // 480 menit bersih → K1 120, K2 120, K3 240 (rumus kategori lama).
  assert.deepStrictEqual([d.k1, d.k2, d.k3], [120, 120, 240]);
  assert.strictEqual(d.totalMinutes, d.k1 + d.k2 + d.k3);
});

test('buildHistoryRows: urutan konsisten (tanggal lalu jam mulai) & lintas tengah malam', () => {
  const rows = [
    row(2, '2026-10-17T22:00:00+08:00', '2026-10-18T02:00:00+08:00'), // lintas hari, atribusi = tanggal mulai
    row(1, '2026-10-16T18:00:00+08:00', '2026-10-16T20:00:00+08:00'),
    row(3, '2026-10-15T08:00:00+08:00', '2026-10-15T10:00:00+08:00'),
  ];
  const data = buildHistoryRows(rows, TZ);
  assert.deepStrictEqual(data.map((d) => d.dateKey), ['2026-10-15', '2026-10-16', '2026-10-17']);
  assert.deepStrictEqual(data.map((d) => d.start), ['08:00', '18:00', '22:00']);
  // Selesai lintas tengah malam ditampilkan apa adanya.
  assert.strictEqual(data[2].end, '02:00');
});

test('buildHistoryRows: dua periode satu hari dialokasikan konsisten dengan splitCategories', () => {
  // Hari ini total 300 menit: K1 120, K2 120, K3 60.
  const rows = [
    row(1, '2026-10-15T08:00:00+08:00', '2026-10-15T11:00:00+08:00'), // 180
    row(2, '2026-10-15T13:00:00+08:00', '2026-10-15T15:20:00+08:00'), // 140 (13:00-15:20)
  ];
  const data = buildHistoryRows(rows, TZ);
  const total = data.reduce((s, d) => s + d.totalMinutes, 0);
  assert.strictEqual(total, 320); // 180 + 140
  const cat = data.reduce((s, d) => ({ 1: s[1] + d.k1, 2: s[2] + d.k2, 3: s[3] + d.k3 }), { 1: 0, 2: 0, 3: 0 });
  const expect = splitCategories(total);
  assert.strictEqual(cat[1], expect[1]);
  assert.strictEqual(cat[2], expect[2]);
  assert.strictEqual(cat[3], expect[3]);
  // Tiap baris: total = jumlah kategori baris itu.
  for (const d of data) assert.strictEqual(d.totalMinutes, d.k1 + d.k2 + d.k3);
});

test('buildHistoryRows: filter status & dedupe identik dengan rekap', () => {
  const rows = [
    row(1, '2026-10-15T08:00:00+08:00', '2026-10-15T10:00:00+08:00', { status: 'active' }),   // diabaikan
    row(2, '2026-10-15T08:00:00+08:00', '2026-10-15T10:00:00+08:00', { status: 'rejected' }), // diabaikan
    row(3, '2026-10-16T08:00:00+08:00', '2026-10-16T10:00:00+08:00'),
    row(3, '2026-10-16T08:00:00+08:00', '2026-10-16T10:00:00+08:00'), // duplikat id
  ];
  const data = buildHistoryRows(rows, TZ);
  assert.strictEqual(data.length, 1);
  assert.strictEqual(data[0].dateKey, '2026-10-16');
});

test('buildHistoryWorkbook: header 7 kolom berbahasa, angka 1 desimal, formula total, tanpa kolom upah', async () => {
  const rows = [row(1, '2026-10-15T08:00:00+08:00', '2026-10-15T11:30:00+08:00')]; // 210 menit
  const data = buildHistoryRows(rows, TZ);
  const { buffer } = await buildHistoryWorkbook({ data, lang: 'id', year: 2026, month: 10 });
  assert.ok(Buffer.isBuffer(buffer));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Riwayat');
  assert.ok(ws, 'worksheet Riwayat ada');
  // Header persis 7 kolom, tanpa nama/departemen/upah/catatan.
  const header = ws.getRow(1).values.slice(1);
  assert.deepStrictEqual(header, ['Tanggal', 'Jam Mulai', 'Jam Selesai', 'Jam 1', 'Jam 2', 'Jam 3', 'Total Jam']);
  assert.strictEqual(ws.columnCount, 7);
  const headerText = JSON.stringify(header);
  for (const banned of ['Nama', 'Departemen', 'Upah', 'Tarif', 'Catatan', 'NT$', 'Keterangan']) {
    assert.ok(!headerText.includes(banned), `tidak boleh ada kolom ${banned}`);
  }
  // Baris data: nilai numerik jam 1 desimal (210 menit → K1 120=2, K2 90=1.5).
  const dataRow = ws.getRow(2);
  assert.strictEqual(dataRow.getCell(1).value, '15-10-2026');
  assert.strictEqual(dataRow.getCell(2).value, '08:00');
  assert.strictEqual(dataRow.getCell(3).value, '11:30');
  assert.strictEqual(dataRow.getCell(4).value, 2); // 120/60
  assert.strictEqual(dataRow.getCell(5).value, 1.5); // 90/60
  assert.strictEqual(dataRow.getCell(6).value, 0);
  assert.strictEqual(dataRow.getCell(7).formula, 'SUM(D2:F2)');
  // Format angka satu desimal.
  assert.strictEqual(ws.getColumn(4).numFmt, HOUR_FMT);
  assert.strictEqual(ws.getColumn(7).numFmt, HOUR_FMT);
  // Baris TOTAL terakhir: formula penjumlahan kolom.
  const totalRow = ws.getRow(ws.rowCount);
  assert.strictEqual(totalRow.getCell(1).value, 'TOTAL');
  assert.strictEqual(totalRow.getCell(4).formula, 'SUM(D2:D2)');
  assert.strictEqual(totalRow.getCell(5).formula, 'SUM(E2:E2)');
  assert.strictEqual(totalRow.getCell(6).formula, 'SUM(F2:F2)');
  assert.strictEqual(totalRow.getCell(7).formula, 'SUM(G2:G2)');
});

test('buildHistoryWorkbook: multi-bahasa & nama file aman', async () => {
  const rows = [row(1, '2026-10-15T08:00:00+08:00', '2026-10-15T10:00:00+08:00')];
  const data = buildHistoryRows(rows, TZ);
  for (const [lang, firstHeader] of [['en', 'Date'], ['zh-TW', '日期'], ['vi', 'Ngày']]) {
    const { buffer } = await buildHistoryWorkbook({ data, lang, year: 2026, month: 10 });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Riwayat');
    assert.strictEqual(ws.getRow(1).getCell(1).value, firstHeader, lang);
  }
  assert.strictEqual(historyFileName(2026, 10), 'riwayat_lembur_2026-10.xlsx');
  assert.ok(!/[^\w.-]/.test(historyFileName(2026, 10)), 'nama file hanya karakter aman');
});

test('periode kosong: tanpa data → kolom jam tetap konsisten (hanya header, tanpa baris TOTAL)', async () => {
  const data = buildHistoryRows([], TZ);
  assert.strictEqual(data.length, 0);
  const { buffer, shown, truncated } = await buildHistoryWorkbook({ data, lang: 'id', year: 2026, month: 10 });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Riwayat');
  assert.strictEqual(ws.rowCount, 1, 'hanya header');
  assert.strictEqual(ws.rowCount === 1, shown.length === 0 && truncated === 0);
});

test('pesan periode kosong diterjemahkan ke 4 bahasa (dipakai handler)', () => {
  for (const lang of ['id', 'en', 'zh-TW', 'vi']) {
    const msg = i18n.t(lang, 'pay.empty', { month: i18n.monthName(lang, 10), year: 2026 });
    assert.ok(msg && msg !== 'pay.empty', lang);
  }
  assert.strictEqual(i18n.t('en', 'pay.empty', { month: i18n.monthName('en', 10), year: 2026 }),
    'No overtime records in October 2026.');
});

test('keamanan file sementara: ekspor memakai buffer in-memory, tanpa fs.writeFileSync', async () => {
  const fs = require('node:fs');
  const src = require('fs').readFileSync('src/services/history-excel.js', 'utf8');
  assert.ok(!src.includes('writeFile'), 'builder tidak menulis file sementara');
  assert.ok(src.includes('writeBuffer'), 'builder memakai writeBuffer in-memory');
  // Sanitasi nama file: tanpa path traversal.
  assert.ok(!historyFileName(2026, 10).includes('/') && !historyFileName(2026, 10).includes('..'));
  assert.ok(!fs.existsSync('/tmp/lunifar-history-test-marker'), 'sanity lingkungan bersih');
});

// ---------- Audit: alur handler hexp: end-to-end (harness bot tiruan) ----------

function makeBotHarness() {
  const handlers = { action: [], hears: [], command: [], on: [] };
  const bot = {
    action: (re, h) => handlers.action.push([re, h]),
    hears: (t, h) => handlers.hears.push([t, h]),
    command: (c, h) => handlers.command.push([c, h]),
    on: (ev, h) => handlers.on.push([ev, h]),
  };
  return { bot, handlers };
}

function makeHexpServices({ exportImpl }) {
  const emp = { id: 7, telegram_user_id: 42, full_name: 'Budi', status: 'active', is_active: 1, language: 'id' };
  return {
    config: { timezone: TZ },
    employeeService: { requireActiveEmployee: async () => emp },
    overtimeRepo: { listByEmployee: async () => [] },
    overtimeService: {
      exportHistory: exportImpl,
      async myStatus() { return { running: null }; },
      async getDailyRecap() { return { rows: [], text: null }; },
      async getMonthlyPayroll() { return { text: '' }; },
    },
  };
}

function hexpCtx() {
  const ctx = {
    from: { id: 42 },
    state: { employee: { id: 7, status: 'active', is_active: 1, language: 'id' } },
    match: null,
    docs: [], replies: [], edits: [], toasts: [],
    reply: async (t, o) => { ctx.replies.push({ t, o }); },
    editMessageText: async (t, o) => { ctx.edits.push({ t, o }); },
    answerCbQuery: async (t) => { ctx.toasts.push(t); },
    replyWithDocument: async (doc) => { ctx.docs.push(doc); },
  };
  return ctx;
}

const fireHexp = async (handlers, ctx, data) => {
  const [, h] = handlers.action.find(([re]) => re.test(data));
  ctx.match = data.match(/^hexp:(?:nav|do):(\d{4})-(\d{2})$/) || [data];
  await h(ctx);
};

test('hexp:open membuka pemilih periode dengan tombol ekspor bulan berjalan', async () => {
  const { bot, handlers } = makeBotHarness();
  const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');
  registerOvertimeHandlers(bot, makeHexpServices({ exportImpl: async () => { throw new Error('tidak boleh dieksekusi'); } }));
  const ctx = hexpCtx();
  await fireHexp(handlers, ctx, 'hexp:open');
  assert.strictEqual(ctx.edits.length + ctx.replies.length, 1, 'picker tampil');
  const markup = (ctx.edits[0] || ctx.replies[0]).o.reply_markup.inline_keyboard;
  // Baris nav + tombol ekspor (hexp:do) + batal
  const allCb = markup.flat().map((b) => b.callback_data);
  assert.ok(allCb.some((c) => /^hexp:do:\d{4}-\d{2}$/.test(c)), 'ada tombol ekspor hexp:do');
  assert.ok(allCb.includes('hexp:cancel'));
  assert.ok(allCb.some((c) => /^hexp:nav:/.test(c)), 'ada navigasi bulan');
});

test('hexp:do mengirim dokumen XLSX dengan nama file dari service', async () => {
  const { bot, handlers } = makeBotHarness();
  const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');
  const fakeBuffer = Buffer.from('xlsx-bytes');
  registerOvertimeHandlers(bot, makeHexpServices({
    exportImpl: async (emp, y, m, lang) => {
      assert.strictEqual(y, 2026); assert.strictEqual(m, 10); assert.strictEqual(lang, 'id');
      return { empty: false, buffer: fakeBuffer, filename: 'riwayat_lembur_2026-10.xlsx' };
    },
  }));
  const ctx = hexpCtx();
  await fireHexp(handlers, ctx, 'hexp:do:2026-10');
  assert.strictEqual(ctx.docs.length, 1);
  assert.strictEqual(ctx.docs[0].source, fakeBuffer);
  assert.strictEqual(ctx.docs[0].filename, 'riwayat_lembur_2026-10.xlsx');
  assert.strictEqual(ctx.replies.length, 0, 'tidak ada klaim teks pengiriman yang salah');
});

test('hexp:do periode kosong → pesan terjemahan, bukan dokumen', async () => {
  const { bot, handlers } = makeBotHarness();
  const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');
  registerOvertimeHandlers(bot, makeHexpServices({ exportImpl: async () => ({ empty: true }) }));
  const ctx = hexpCtx();
  await fireHexp(handlers, ctx, 'hexp:do:2026-10');
  assert.strictEqual(ctx.docs.length, 0);
  assert.ok(ctx.replies[0].t.includes('Belum ada catatan lembur pada Oktober 2026'));
});

test('hexp:do gagal → toast gagal tanpa bocoran detail internal', async () => {
  const { bot, handlers } = makeBotHarness();
  const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');
  registerOvertimeHandlers(bot, makeHexpServices({
    exportImpl: async () => { const e = new Error('SQL leak: SELECT * FROM employees WHERE password=...'); throw e; },
  }));
  const ctx = hexpCtx();
  await fireHexp(handlers, ctx, 'hexp:do:2026-10');
  assert.strictEqual(ctx.docs.length, 0);
  assert.strictEqual(ctx.replies.length, 0);
  assert.ok(ctx.toasts.some((t) => typeof t === 'string' && t.includes('Gagal membuat atau mengirim file')));
  for (const t of ctx.toasts) assert.ok(!t.includes('password'), 'tidak bocor detail internal');
});

test('hexp: parameter bulan tidak valid ditolak tanpa eksekusi service', async () => {
  const { bot, handlers } = makeBotHarness();
  const { registerOvertimeHandlers } = require('../src/bot/handlers/overtime');
  registerOvertimeHandlers(bot, makeHexpServices({ exportImpl: async () => { throw new Error('tidak boleh'); } }));
  const ctx = hexpCtx();
  await fireHexp(handlers, ctx, 'hexp:do:2100-13');
  assert.strictEqual(ctx.docs.length, 0);
  assert.ok(ctx.toasts.includes('Bulan tidak valid.'));
});
