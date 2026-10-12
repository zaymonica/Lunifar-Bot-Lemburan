'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeFakeOvertimeRepo, makeEmployee, makeOvertime } = require('./helpers/overtime-fake');

test('mulai lembur lalu selesai — durasi 90 menit, payable 90', async () => {
  const repo = makeFakeOvertimeRepo();
  const overtime = makeOvertime(repo);
  const emp = makeEmployee(1);
  await overtime.startSession(emp, 'deadline proyek');
  const fin = await overtime.finishSession(emp);
  assert.strictEqual(fin.actualMinutes, 90);
  assert.strictEqual(fin.payableMinutes, 90);
  assert.strictEqual(fin.session.status, 'pending');
});

test('mulai lembur ganda ditolak (race condition disimulasikan)', async () => {
  const repo = makeFakeOvertimeRepo();
  const overtime = makeOvertime(repo);
  const emp = makeEmployee(1);
  await overtime.startSession(emp, null);
  await assert.rejects(() => overtime.startSession(emp, null), /aktif/);
});

test('selesai tanpa sesi aktif ditolak', async () => {
  const repo = makeFakeOvertimeRepo();
  const overtime = makeOvertime(repo);
  await assert.rejects(() => overtime.finishSession(makeEmployee(2)), /Tidak ada sesi/);
});

test('durasi di bawah minimum -> payable null', async () => {
  const repo = makeFakeOvertimeRepo();
  const overtime = makeOvertime(repo);
  const emp = makeEmployee(1);
  await overtime.startSession(emp, null);
  const s = repo.sessions.get(1);
  s.end_at = new Date(s.start_at.getTime() + 20 * 60000);
  s.status = 'pending';
  const minutes = Math.round((s.end_at - s.start_at) / 60000);
  const { payableMinutes } = require('../src/utils/duration');
  assert.strictEqual(payableMinutes(minutes, { minMinutes: 30, roundingMinutes: 15 }), null);
});
