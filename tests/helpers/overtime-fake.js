'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { OvertimeService } = require('../../src/services/overtime.service');

const CONFIG = { timezone: 'Asia/Jakarta', overtime: { minMinutes: 30, roundingMinutes: 15, maxHoursPerDay: 8 } };

function makeFakeOvertimeRepo() {
  const sessions = new Map();
  let nextId = 1;
  return {
    sessions,
    async findActiveByEmployee(empId) { return [...sessions.values()].find((s) => s.employee_id === empId && s.status === 'active') || null; },
    async createActive(empId, note) {
      if ([...sessions.values()].some((s) => s.employee_id === empId && s.status === 'active')) {
        const err = new Error('dup'); err.code = 'ER_DUP_ENTRY'; throw err;
      }
      const id = nextId++;
      sessions.set(id, { id, employee_id: empId, note, start_at: new Date(), end_at: null, status: 'active', actual_minutes: null, payable_minutes: null, approved_by: null, decision_note: null });
      return id;
    },
    async finishActive(sessionId) {
      const s = sessions.get(sessionId);
      if (!s || s.status !== 'active') return false;
      s.end_at = new Date(s.start_at.getTime() + 90 * 60000);
      s.status = 'pending';
      return true;
    },
    async findById(id) { return sessions.get(Number(id)) || null; },
    async listByEmployee(empId) { return [...sessions.values()].filter((s) => s.employee_id === empId); },
    async setDecision(sessionId, status, approverId, note, actual, payable) {
      const s = sessions.get(Number(sessionId));
      if (!s || s.status !== 'pending') return false;
      Object.assign(s, { status, approved_by: approverId, decision_note: note, actual_minutes: actual, payable_minutes: payable });
      return true;
    },
    async search() { return [...sessions.values()]; },
    async statsToday() { return { active_count: 0, pending_count: 0 }; },
  };
}

function makeEmployee(id, role = 'employee') {
  return { id, telegram_user_id: 1000 + id, full_name: `Emp${id}`, role, status: 'active', is_active: 1 };
}

function makeOvertime(repo) {
  return new OvertimeService({
    overtimeRepo: repo,
    auditRepo: { async log() {} },
    notificationService: { async notifyAdmins() {}, async sendTo() {} },
    config: CONFIG,
  });
}

module.exports = { makeFakeOvertimeRepo, makeEmployee, makeOvertime, CONFIG };

if (require.main === module) {
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
    assert.strictEqual(payableMinutes(minutes, CONFIG.overtime), null);
  });
}
