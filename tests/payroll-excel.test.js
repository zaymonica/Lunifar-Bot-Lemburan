'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ExcelJS = require('exceljs');
const {
  allocatePeriods, parseMonthParam, navKeyboard,
} = require('../src/services/payroll');
const { OvertimeService } = require('../src/services/overtime.service');
const { exportFileName } = require('../src/services/payroll-excel');

const TZ = 'Asia/Taipei';

function row(id, status, startLocal, endLocal) {
  const toIso = (s) => (s.includes('Z') ? new Date(s).toISOString() : new Date(`${s}+08:00`).toISOString());
  return { id, status, start_at: toIso(startLocal), end_at: endLocal ? toIso(endLocal) : null };
}

async function loadWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

function makeService(repoRows) {
  const calls = [];
  const fakeRepo = {
    async listByEmployeeAndWindow(...args) { calls.push(args); return repoRows; },
  };
  return { svc: new OvertimeService({ overtimeRepo: fakeRepo, config: { timezone: TZ } }), calls };
}

test('allocatePeriods: satu periode 300 menit terbagi 120/120/60 lintas kategori', () => {
  const [a] = allocatePeriods([{ minutes: 300 }]);
  assert.strictEqual(a.categories[1], 120);
  assert.strictEqual(a.categories[2], 120);
  assert.strictEqual(a.categories[3], 60);
  assert.strictEqual(a.totalCents, 32696 + 40748 + 32574);
});

test('allocatePeriods: dua periode 60+180 — total kategori sama dengan splitCategories(240)', () => {
  const [a, b] = allocatePeriods([{ minutes: 60 }, { minutes: 180 }]);
  assert.strictEqual(a.categories[1], 60);
  assert.strictEqual(b.categories[1], 60);
  assert.strictEqual(b.categories[2], 120);
  assert.strictEqual(a.categories[1] + b.categories[1], 120);
  assert.strictEqual(a.categories[2] + b.categories[2], 120);
  assert.strictEqual(a.categories[3] + b.categories[3], 0);
});

test('parseMonthParam: valid dan invalid', () => {
  assert.deepStrictEqual(parseMonthParam('2026-10'), { y: 2026, m: 10 });
  assert.strictEqual(parseMonthParam('2026-13'), null);
  assert.strictEqual(parseMonthParam('2026-00'), null);
  assert.strictEqual(parseMonthParam('999-10'), null);
  assert.strictEqual(parseMonthParam('2026-1'), null);
  assert.strictEqual(parseMonthParam('abc'), null);
  assert.strictEqual(parseMonthParam(null), null);
});

test('navKeyboard: baris navigasi utuh + baris export terpisah dengan callback exp:', () => {
  const kb = navKeyboard(2026, 9, 2026, 10);
  assert.strictEqual(kb.length, 2);
  assert.deepStrictEqual(kb[0].map((b) => b.callback_data), ['pay:2026-08', 'pay:2026-10']);
  assert.strictEqual(kb[1][0].callback_data, 'exp:2026-09');
  assert.notStrictEqual(kb[1][0].callback_data.slice(0, 4), 'pay:');
  const cur = navKeyboard(2026, 10, 2026, 10);
  assert.deepStrictEqual(cur[0].map((b) => b.callback_data), ['pay:2026-09']);
});

test('exportFileName aman untuk Telegram', () => {
  assert.strictEqual(exportFileName(2026, 10), 'lembur_2026-10.xlsx');
  assert.ok(/^[\w.\-]+$/.test(exportFileName(2026, 1)));
});

test('exportMonthlyPayroll: 3 worksheet, ringkasan = hasil payroll layanan, rincian & harian konsisten', async () => {
  const rows = [
    row(1, 'completed', '2026-10-01T10:00:00', '2026-10-01T13:00:00'), // 180m → K1 120 + K2 60
    row(2, 'completed', '2026-10-02T00:30:00', '2026-10-02T04:30:00'), // 240m
    row(3, 'active', '2026-10-03T10:00:00', null), // diabaikan
    row(4, 'rejected', '2026-10-04T10:00:00', '2026-10-04T11:00:00'), // diabaikan
  ];
  const { svc } = makeService(rows);
  const { buffer, filename, aggregate } = await svc.exportMonthlyPayroll({ id: 42 }, 2026, 10);
  assert.strictEqual(filename, 'lembur_2026-10.xlsx');
  const wb = await loadWorkbook(buffer);
  assert.deepStrictEqual(wb.worksheets.map((s) => s.name),
    ['Ringkasan Bulanan', 'Rincian Lembur', 'Rekap Harian']);

  const expected = (await svc.getMonthlyPayroll({ id: 42 }, 2026, 10)).aggregate;
  assert.strictEqual(aggregate.totals.totalCents, expected.totals.totalCents);
  assert.strictEqual(aggregate.totals.dayCount, 2);
  assert.strictEqual(aggregate.totals.minutes, 420);

  const s1 = wb.getWorksheet('Ringkasan Bulanan');
  const getVal = (a) => s1.getCell(a).value;
  assert.strictEqual(getVal('B3'), expected.totals.dayCount);
  assert.strictEqual(getVal('B5'), expected.totals.minutes);
  assert.strictEqual(getVal('B7'), expected.totals.catCents[1] / 100);
  assert.strictEqual(getVal('B9'), expected.totals.catCents[2] / 100);
  assert.strictEqual(getVal('B11'), expected.totals.catCents[3] / 100);
  assert.strictEqual(getVal('B12'), expected.totals.totalCents / 100);

  const s2 = wb.getWorksheet('Rincian Lembur');
  assert.strictEqual(s2.rowCount, 3); // header + 2 periode valid
  assert.ok(s2.autoFilter);
  // Periode #1: 180 menit → K1 120, K2 60 (bukan seluruhnya satu kategori).
  const p1 = s2.getRow(2);
  assert.strictEqual(p1.getCell(8).value, 120); // K1 menit
  assert.strictEqual(p1.getCell(10).value, 60); // K2 menit
  assert.strictEqual(p1.getCell(12).value, 0); // K3 menit
  // Periode #2: 240 menit → K1 120, K2 120, K3 0.
  const p2 = s2.getRow(3);
  assert.strictEqual(p2.getCell(8).value, 120);
  assert.strictEqual(p2.getCell(10).value, 120);
  assert.strictEqual(p2.getCell(12).value, 0);
  // Status tercantum; kolom istirahat = 0 (baris tanpa break_minutes).
  assert.strictEqual(p1.getCell(7).value, 'completed');
  assert.strictEqual(p1.getCell(6).value, 0);

  const s3 = wb.getWorksheet('Rekap Harian');
  assert.strictEqual(s3.rowCount, 3); // header + 2 hari
  // Hari 01-10: 180 menit, 1 periode; hari 02-10: 240 menit, 1 periode.
  assert.strictEqual(s3.getRow(2).getCell(4).value, 180);
  assert.strictEqual(s3.getRow(3).getCell(4).value, 240);
  // Upah K1 hari-1 (120m) = NT$326,96.
  assert.strictEqual(s3.getRow(2).getCell(6).value, 326.96);
});

test('bulan kosong: workbook valid dengan total nol', async () => {
  const { svc } = makeService([row(9, 'completed', '2026-09-30T15:00:00Z', '2026-09-30T18:00:00Z')]);
  const { buffer } = await svc.exportMonthlyPayroll({ id: 42 }, 2026, 10);
  const wb = await loadWorkbook(buffer);
  assert.deepStrictEqual(wb.worksheets.map((s) => s.name),
    ['Ringkasan Bulanan', 'Rincian Lembur', 'Rekap Harian']);
  const s1 = wb.getWorksheet('Ringkasan Bulanan');
  assert.strictEqual(s1.getCell('B3').value, 0);
  assert.strictEqual(s1.getCell('B5').value, 0);
  assert.strictEqual(s1.getCell('B12').value, 0);
  assert.strictEqual(wb.getWorksheet('Rincian Lembur').rowCount, 1); // header saja
  assert.strictEqual(wb.getWorksheet('Rekap Harian').rowCount, 1);
});

test('batas bulan Asia/Taipei: periode mulai 30 Sep 23:00 lokal tidak masuk ekspor Oktober', async () => {
  const rows = [
    row(1, 'completed', '2026-09-30T15:00:00Z', '2026-09-30T18:00:00Z'), // 30 Sep 23:00 lokal
    row(2, 'completed', '2026-09-30T16:30:00Z', '2026-09-30T18:30:00Z'), // 1 Okt 00:30 lokal
  ];
  const { svc } = makeService(rows);
  const { buffer } = await svc.exportMonthlyPayroll({ id: 42 }, 2026, 10);
  const wb = await loadWorkbook(buffer);
  assert.strictEqual(wb.getWorksheet('Rincian Lembur').rowCount, 2); // header + 1 periode (1 Okt)
  const only = wb.getWorksheet('Rincian Lembur').getRow(2);
  assert.strictEqual(only.getCell(1).value, '01-10-2026');
});

test('ekspor read-only: hanya listByEmployeeAndWindow yang dipanggil, terikat employee.id peminta', async () => {
  const calls = [];
  const fakeRepo = {
    async listByEmployeeAndWindow(id, s, e) { calls.push({ id, s, e }); return []; },
  };
  const svc = new OvertimeService({ overtimeRepo: fakeRepo, config: { timezone: TZ } });
  await svc.exportMonthlyPayroll({ id: 77 }, 2026, 10);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].id, 77); // selalu employee dari konteks, bukan dari callback
});

test('kegagalan repo → error naik (handler menangkap; tidak ada file temp yang ditulis)', async () => {
  const svc = new OvertimeService({
    overtimeRepo: { async listByEmployeeAndWindow() { throw new Error('db down'); } },
    config: { timezone: TZ },
  });
  await assert.rejects(() => svc.exportMonthlyPayroll({ id: 1 }, 2026, 10), /db down/);
});
