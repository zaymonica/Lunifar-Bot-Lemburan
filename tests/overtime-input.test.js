'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  parseDateDDMMYYYY, parseTimeHHMM, resolvePeriod, periodsOverlap, formatDailyRecap, formatDurationId,
} = require('../src/services/overtime-input');
const { OvertimeService } = require('../src/services/overtime.service');
const { ConflictError, ValidationError } = require('../src/utils/errors');

const TZ = 'Asia/Taipei';
const CONFIG = { timezone: TZ, overtime: { minMinutes: 30, roundingMinutes: 15, maxHoursPerDay: 8 } };
const EMP = { id: 1, telegram_user_id: 111, full_name: 'Budi' };

/** Fake repo menyimulasikan tabel overtime_sessions (waktu sebagai Date UTC). */
function makeRepo() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    async listByEmployeeAndWindow(employeeId, windowStart, windowEnd) {
      return rows.filter((r) => r.employee_id === employeeId && r.status !== 'active'
        && r.start_at < windowEnd && r.end_at > windowStart);
    },
    async withTransaction(fn) { return fn({}); },
    async createManual(employeeId, startAt, endAt, actualMinutes, payableMinutes, note) {
      const id = nextId++;
      rows.push({ id, employee_id: employeeId, start_at: new Date(startAt), end_at: new Date(endAt), actual_minutes: actualMinutes, payable_minutes: payableMinutes, note, status: 'completed', approved_by: null });
      return id;
    },
    async findById(id) { return rows.find((r) => r.id === id) || null; },
  };
}
function makeAudit() { return { logs: [], async log(a, action) { this.logs.push(action); } }; }
function makeSvc() { return new OvertimeService({ overtimeRepo: makeRepo(), auditRepo: makeAudit(), notificationService: {}, config: CONFIG }); }

const D = (y, m, d) => ({ y, m, d });
const T = (h, min) => ({ h, min });

test('parser tanggal ketat: valid, format salah, kalender salah', () => {
  assert.deepStrictEqual(parseDateDDMMYYYY('01-10-2026'), D(2026, 10, 1));
  assert.throws(() => parseDateDDMMYYYY('2026-10-01'), ValidationError);
  assert.throws(() => parseDateDDMMYYYY('1-10-2026'), ValidationError);
  assert.throws(() => parseDateDDMMYYYY('31-02-2026'), /kalender/);
  assert.throws(() => parseDateDDMMYYYY('99-99-2026'), ValidationError);
  assert.throws(() => parseDateDDMMYYYY(''), ValidationError);
});

test('parser jam ketat', () => {
  assert.deepStrictEqual(parseTimeHHMM('16:30'), T(16, 30));
  assert.deepStrictEqual(parseTimeHHMM('00:00'), T(0, 0));
  assert.throws(() => parseTimeHHMM('24:00'), ValidationError);
  assert.throws(() => parseTimeHHMM('7:30'), ValidationError);
  assert.throws(() => parseTimeHHMM('16:5'), ValidationError);
});

test('resolvePeriod: konversi Asia/Taipei → UTC benar', () => {
  const p = resolvePeriod(D(2026, 10, 1), T(12, 0), T(13, 0), { timezone: TZ });
  assert.strictEqual(p.startUtc.toISOString(), '2026-10-01T04:00:00.000Z');
  assert.strictEqual(p.endUtc.toISOString(), '2026-10-01T05:00:00.000Z');
  assert.strictEqual(p.minutes, 60);
});

test('resolvePeriod: selesai < mulai → sinyal CROSS_MIDNIGHT (tidak menebak)', () => {
  assert.throws(() => resolvePeriod(D(2026, 10, 1), T(23, 0), T(1, 0), { timezone: TZ }),
    (e) => e.code === 'CROSS_MIDNIGHT');
  const p = resolvePeriod(D(2026, 10, 1), T(23, 0), T(1, 0), { crossMidnight: true, timezone: TZ });
  assert.strictEqual(p.minutes, 120);
  assert.strictEqual(p.endUtc.toISOString(), '2026-10-01T17:00:00.000Z');
});

// ===== Tes level service (multi-periode, duplikat, tumpang tindih, rekap) =====

test('dua periode pada tanggal sama → total 2 jam, record terpisah', async () => {
  const svc = makeSvc();
  const r1 = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(13, 0) });
  const r2 = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(16, 30), end: T(17, 30) });
  assert.strictEqual(r1.dayTotalMinutes, 60);
  assert.strictEqual(r2.dayTotalMinutes, 120);
  assert.notStrictEqual(r1.session.id, r2.session.id);
});

test('tiga periode atau lebih pada tanggal sama tetap diizinkan', async () => {
  const svc = makeSvc();
  await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(8, 0), end: T(9, 0) });
  await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(13, 0) });
  const r3 = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(16, 30), end: T(17, 30) });
  assert.strictEqual(r3.dayTotalMinutes, 180);
});

test('periode pada tanggal berbeda tidak saling memengaruhi total harian', async () => {
  const svc = makeSvc();
  await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(13, 0) });
  const r2 = await svc.createManualPeriod(EMP, { date: D(2026, 10, 2), start: T(12, 0), end: T(13, 0) });
  assert.strictEqual(r2.dayTotalMinutes, 60);
});

test('duplikat identik ditolak; periode berbeda di hari sama tidak dianggap duplikat', async () => {
  const svc = makeSvc();
  await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(13, 0) });
  await assert.rejects(() => svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(13, 0) }),
    ConflictError);
  const r = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(13, 30), end: T(14, 30) });
  assert.ok(r.session);
  assert.strictEqual(r.needsConfirm, false);
});

test('tumpang tindih: needsConfirm dulu, simpan hanya dengan force', async () => {
  const svc = makeSvc();
  await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(14, 0) });
  const res = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(13, 0), end: T(15, 0) });
  assert.strictEqual(res.needsConfirm, true);
  assert.strictEqual(res.overlapping.length, 1);
  assert.strictEqual(svc.overtimeRepo.rows.length, 1); // belum tersimpan
  const saved = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(13, 0), end: T(15, 0) }, { force: true });
  assert.strictEqual(saved.session.status, 'completed');
  assert.strictEqual(svc.overtimeRepo.rows.length, 2);
});

test('lembur lintas tengah malam tersimpan setelah crossMidnight', async () => {
  const svc = makeSvc();
  const r = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(23, 0), end: T(1, 0), crossMidnight: true });
  assert.strictEqual(r.actualMinutes, 120);
  assert.strictEqual(r.session.start_at.toISOString(), '2026-10-01T15:00:00.000Z');
});

test('audit log tercatat untuk input manual', async () => {
  const svc = makeSvc();
  await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(13, 0) });
  assert.ok(svc.auditRepo.logs.includes('overtime.manual_input'));
});

test('payable mengikuti kebijakan per periode (min 30, pembulatan 15)', async () => {
  const svc = makeSvc();
  const r = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(12, 0), end: T(12, 40) });
  assert.strictEqual(r.actualMinutes, 40);
  assert.strictEqual(r.payableMinutes, 45);
});

test('formatDailyRecap: urut mulai, format periode, total harian', () => {
  const rows = [
    { start_at: new Date('2026-10-01T08:30:00Z'), end_at: new Date('2026-10-01T09:30:00Z'), status: 'pending' }, // 16:30-17:30 lokal
    { start_at: new Date('2026-10-01T04:00:00Z'), end_at: new Date('2026-10-01T05:00:00Z'), status: 'approved' }, // 12:00-13:00 lokal
  ];
  const text = formatDailyRecap(rows, TZ);
  assert.ok(text.includes('Tanggal lembur: 1 Oktober 2026'));
  assert.ok(text.indexOf('12:00') < text.indexOf('16:30'));
  assert.ok(text.includes('Periode 1'));
  assert.ok(text.includes('Periode 2'));
  assert.ok(text.includes('Total lembur harian: 2 jam'));
  // Record lama 'pending' tidak lagi ditampilkan sebagai menunggu persetujuan admin.
  assert.ok(!text.includes('menunggu persetujuan'));
  assert.ok(text.includes('Periode 2 (data lama)'));
  // Periode berstatus non-pending (mis. 'approved') tampil tanpa tag apa pun.
  assert.ok(!text.includes('Periode 1 ('));
});

test('formatDailyRecap: mengabaikan entri aktif/tertolak', () => {
  const rows = [{ start_at: new Date('2026-10-01T04:00:00Z'), end_at: new Date('2026-10-01T05:00:00Z'), status: 'rejected' }];
  assert.strictEqual(formatDailyRecap(rows, TZ), null);
});

test('kompatibilitas data lama: sesi realtime lama tetap terhitung di rekap harian', async () => {
  const svc = makeSvc();
  // Sesi lama (dibuat alur realtime sebelumnya) berstatus approved.
  svc.overtimeRepo.rows.push({
    id: 99, employee_id: EMP.id, status: 'approved',
    start_at: new Date('2026-10-01T04:00:00Z'), end_at: new Date('2026-10-01T05:00:00Z'),
    actual_minutes: 60, payable_minutes: 60,
  });
  const r = await svc.createManualPeriod(EMP, { date: D(2026, 10, 1), start: T(16, 30), end: T(17, 30) });
  assert.strictEqual(r.dayTotalMinutes, 120); // 60 lama + 60 baru
  const recap = await svc.getDailyRecap(EMP, D(2026, 10, 1));
  assert.ok(recap.text.includes('Periode 1'));
  assert.ok(recap.text.includes('Periode 2'));
  assert.ok(recap.text.includes('Total lembur harian: 2 jam'));
});


test('resolvePeriod: durasi nol ditolak', () => {
  assert.throws(() => resolvePeriod(D(2026, 10, 1), T(9, 0), T(9, 0), { timezone: TZ }), /0 menit/);
});

test('periodsOverlap dasar', () => {
  const aS = new Date('2026-10-01T04:00:00Z'); const aE = new Date('2026-10-01T05:00:00Z');
  assert.ok(periodsOverlap(aS, aE, new Date('2026-10-01T04:30:00Z'), new Date('2026-10-01T06:00:00Z')));
  assert.ok(!periodsOverlap(aS, aE, new Date('2026-10-01T05:00:00Z'), new Date('2026-10-01T06:00:00Z')));
});

test('formatDurationId ramah Indonesia', () => {
  assert.strictEqual(formatDurationId(120), '2 jam');
  assert.strictEqual(formatDurationId(90), '1 jam 30 menit');
  assert.strictEqual(formatDurationId(45), '45 menit');
});