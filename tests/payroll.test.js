'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  RATE_CENTS_PER_HOUR, splitCategories, centsFor, dayPay, formatCents,
  localDateKey, aggregateMonthly, formatMonthlyText, navKeyboard,
} = require('../src/services/payroll');
const { OvertimeService } = require('../src/services/overtime.service');

const TZ = 'Asia/Taipei';

// Baris sesi palsu. startAt/endAt = wall-clock lokal Taipei (UTC+8).
function row(id, status, startLocal, endLocal) {
  const toIso = (s) => (s.includes('Z') ? new Date(s).toISOString() : new Date(`${s}+08:00`).toISOString());
  return {
    id,
    status,
    start_at: toIso(startLocal),
    end_at: endLocal ? toIso(endLocal) : null,
  };
}

test('splitCategories: contoh spesifikasi', () => {
  const cases = [
    [30, { 1: 30, 2: 0, 3: 0 }],
    [60, { 1: 60, 2: 0, 3: 0 }],
    [120, { 1: 120, 2: 0, 3: 0 }],
    [180, { 1: 120, 2: 60, 3: 0 }],
    [240, { 1: 120, 2: 120, 3: 0 }],
    [300, { 1: 120, 2: 120, 3: 60 }],
  ];
  for (const [input, expected] of cases) assert.deepStrictEqual(splitCategories(input), expected);
});

test('tarif per jam sesuai rumus 122 × faktor (integer sen)', () => {
  assert.strictEqual(RATE_CENTS_PER_HOUR[1], 16348); // NT$163,48
  assert.strictEqual(RATE_CENTS_PER_HOUR[2], 20374); // NT$203,74
  assert.strictEqual(RATE_CENTS_PER_HOUR[3], 32574); // NT$325,74
});

test('contoh spesifikasi 5 jam: nominal per kategori dan total', () => {
  const pay = dayPay(300);
  assert.deepStrictEqual(pay.categories[1], { minutes: 120, cents: 32696 });
  assert.deepStrictEqual(pay.categories[2], { minutes: 120, cents: 40748 });
  assert.deepStrictEqual(pay.categories[3], { minutes: 60, cents: 32574 });
  assert.strictEqual(pay.totalCents, 106018);
  assert.strictEqual(formatCents(pay.totalCents), 'NT$1.060,18');
});

test('durasi 0,5 jam dan 1 jam', () => {
  assert.strictEqual(centsFor(30, 1), Math.round(30 * 16348 / 60)); // NT$81,74
  assert.strictEqual(formatCents(centsFor(30, 1)), 'NT$81,74');
  assert.strictEqual(centsFor(60, 1), 16348);
  assert.strictEqual(formatCents(centsFor(60, 2)), 'NT$203,74');
});

test('formatCents: NT$ dua desimal, ribuan titik, tanpa Rp', () => {
  assert.strictEqual(formatCents(0), 'NT$0,00');
  assert.strictEqual(formatCents(500), 'NT$5,00');
  assert.strictEqual(formatCents(123456789), 'NT$1.234.567,89');
  assert.ok(!formatCents(123456789).includes('Rp'));
  for (const minutes of [30, 60, 120, 180, 240, 300]) {
    const text = formatCents(dayPay(minutes).totalCents);
    assert.ok(text.startsWith('NT$') && !text.includes('Rp'), text);
  }
});

test('dua periode 1 jam pada tanggal sama = 2 jam kategori 1 (bukan reset per periode)', () => {
  const rows = [row(1, 'completed', '2026-10-01T12:00:00', '2026-10-01T13:00:00'),
    row(2, 'completed', '2026-10-01T16:30:00', '2026-10-01T17:30:00')];
  const agg = aggregateMonthly(rows, TZ);
  assert.strictEqual(agg.days.length, 1);
  assert.strictEqual(agg.days[0].totalMinutes, 120);
  assert.strictEqual(agg.totals.categories[1], 120);
  assert.strictEqual(agg.totals.categories[2], 0);
  assert.strictEqual(agg.totals.categories[3], 0);
  assert.strictEqual(agg.totals.totalCents, 2 * 16348);
});

test('beberapa tanggal dengan durasi berbeda + akumulasi lintas tanggal', () => {
  const rows = [
    row(1, 'completed', '2026-10-01T18:00:00', '2026-10-01T20:00:00'), // 120m → K1
    row(2, 'completed', '2026-10-02T18:00:00', '2026-10-02T21:00:00'), // 180m → K1+K2
    row(3, 'completed', '2026-10-03T18:00:00', '2026-10-03T23:00:00'), // 300m → K1+K2+K3
  ];
  const agg = aggregateMonthly(rows, TZ);
  assert.strictEqual(agg.totals.dayCount, 3);
  assert.strictEqual(agg.totals.minutes, 600);
  assert.strictEqual(agg.totals.categories[1], 360);
  assert.strictEqual(agg.totals.categories[2], 180);
  assert.strictEqual(agg.totals.categories[3], 60);
  // Jumlah menit kategori = total menit aktual (tidak ada menit hilang/ganda).
  assert.strictEqual(agg.totals.categories[1] + agg.totals.categories[2] + agg.totals.categories[3], agg.totals.minutes);
  // Nominal bulanan = penjumlahan nominal harian (bukan jam × tarif tunggal).
  const expected = dayPay(120).totalCents + dayPay(180).totalCents + dayPay(300).totalCents;
  assert.strictEqual(agg.totals.totalCents, expected);
});

test('sesi aktif tanpa end_at dan record rejected tidak dihitung', () => {
  const rows = [
    row(1, 'active', '2026-10-05T18:00:00', null),
    row(2, 'rejected', '2026-10-06T18:00:00', '2026-10-06T20:00:00'),
    row(3, 'completed', '2026-10-07T18:00:00', '2026-10-07T19:00:00'),
  ];
  const agg = aggregateMonthly(rows, TZ);
  assert.strictEqual(agg.totals.minutes, 60);
  assert.strictEqual(agg.totals.dayCount, 1);
});

test('data lama valid (pending) tetap dihitung', () => {
  const rows = [row(1, 'pending', '2026-10-01T12:00:00', '2026-10-01T14:30:00')];
  const agg = aggregateMonthly(rows, TZ);
  assert.strictEqual(agg.totals.minutes, 150);
});

test('anti penghitungan ganda: baris sama (id sama) hanya dihitung sekali', () => {
  const r = row(7, 'completed', '2026-10-09T18:00:00', '2026-10-09T20:00:00');
  const agg = aggregateMonthly([r, { ...r }], TZ);
  assert.strictEqual(agg.totals.minutes, 120);
  assert.strictEqual(agg.totals.totalCents, 2 * 16348);
});

test('atribusi zona waktu Asia/Taipei lintas batas hari/bulan', () => {
  // 2026-10-01T00:30+08:00 = 2026-09-30T16:30Z → masuk Oktober.
  const rIn = {
    id: 1, status: 'completed',
    start_at: '2026-09-30T16:30:00Z', end_at: '2026-09-30T18:30:00Z',
  };
  const agg = aggregateMonthly([rIn], TZ);
  assert.strictEqual(agg.days[0].key, '2026-10-01');
  assert.strictEqual(localDateKey(new Date(rIn.start_at), TZ), '2026-10-01');
  // Sesi mulai 31 Okt lokal → tetap atribusi Oktober meski selesai di Nov.
  const rEnd = row(2, 'completed', '2026-10-31T17:00:00', '2026-11-01T02:00:00');
  assert.strictEqual(localDateKey(new Date(rEnd.start_at), TZ), '2026-10-31');
});

test('formatMonthlyText: bulan kosong menampilkan nol + pesan jelas, tanpa Rp', () => {
  const agg = aggregateMonthly([], TZ);
  const text = formatMonthlyText(agg, 2026, 9);
  assert.ok(text.includes('September 2026'));
  assert.ok(text.includes('Belum ada catatan lembur'));
  assert.ok(text.includes('NT$0,00'));
  assert.ok(!text.includes('Rp'));
});

test('formatMonthlyText: bulan berisi memuat nama bulan, tarif, dan rincian harian', () => {
  const rows = [row(1, 'completed', '2026-10-01T18:00:00', '2026-10-01T23:00:00')];
  const text = formatMonthlyText(aggregateMonthly(rows, TZ), 2026, 10);
  assert.ok(text.includes('Oktober 2026'));
  assert.ok(text.includes('NT$163,48') && text.includes('NT$203,74') && text.includes('NT$325,74'));
  assert.ok(text.includes('NT$1.060,18'));
  assert.ok(text.includes('01-10'));
  assert.ok(!text.includes('Rp'));
});

test('navKeyboard: next disembunyikan pada bulan berjalan, tampil untuk bulan lampau', () => {
  const cur = navKeyboard(2026, 10, 2026, 10);
  assert.strictEqual(cur[0].length, 1);
  assert.strictEqual(cur[0][0].callback_data, 'pay:2026-09');
  const past = navKeyboard(2026, 9, 2026, 10);
  assert.strictEqual(past[0].length, 2);
  assert.strictEqual(past[0][1].callback_data, 'pay:2026-10');
  // Pergantian tahun Desember ↔ Januari.
  const dec = navKeyboard(2025, 12, 2026, 10);
  assert.strictEqual(dec[0][0].callback_data, 'pay:2025-11');
  const jan = navKeyboard(2026, 1, 2026, 10);
  assert.strictEqual(jan[0][1].callback_data, 'pay:2026-02');
});

test('OvertimeService.getMonthlyPayroll: window bulan + anti double-count lintas bulan', async () => {
  const calls = [];
  const fakeRepo = {
    async listByEmployeeAndWindow(empId, windowStart, windowEnd) {
      calls.push({ empId, windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString() });
      return [
        row(1, 'completed', '2026-10-01T18:00:00', '2026-10-01T20:00:00'),
        // Mulai 30 Sep 23:00 lokal (15:00Z) — sebelum windowStart → dibuang service.
        row(2, 'completed', '2026-09-30T15:00:00Z', '2026-09-30T18:00:00Z'),
        row(3, 'active', '2026-10-05T18:00:00', null),
      ];
    },
  };
  const svc = new OvertimeService({ overtimeRepo: fakeRepo, config: { timezone: TZ } });
  const { aggregate, text } = await svc.getMonthlyPayroll({ id: 42 }, 2026, 10);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(new Date(calls[0].windowStart).toISOString(), '2026-09-30T16:00:00.000Z');
  assert.strictEqual(new Date(calls[0].windowEnd).toISOString(), '2026-10-31T16:00:00.000Z');
  assert.strictEqual(aggregate.totals.minutes, 120); // hanya row 1
  assert.strictEqual(aggregate.totals.dayCount, 1);
  assert.strictEqual(aggregate.totals.totalCents, 2 * 16348);
  assert.ok(text.includes('Oktober 2026'));
});

test('durasi 0,5-5 jam: total menit kategori = durasi (invarian)', () => {
  for (const minutes of [30, 60, 120, 180, 240, 300]) {
    const pay = dayPay(minutes);
    const sum = pay.categories[1].minutes + pay.categories[2].minutes + pay.categories[3].minutes;
    assert.strictEqual(sum, minutes, `durasi ${minutes}`);
  }
});
