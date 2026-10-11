'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makeFakeOvertimeRepo, makeEmployee } = require('./helpers/overtime-fake');
const { ApprovalService } = require('../src/services/approval.service');

const CONFIG = { timezone: 'Asia/Jakarta', overtime: { minMinutes: 30, roundingMinutes: 15 } };

function makeApproval(repo) {
  return new ApprovalService({
    overtimeRepo: repo,
    approvalRepo: { async record() {} },
    auditRepo: { async log() {} },
    notificationService: { async notifyAdmins() {}, async sendTo() {} },
    config: CONFIG,
  });
}

async function pendingSession(repo) {
  const { makeOvertime } = require('./helpers/overtime-fake');
  const overtime = makeOvertime(repo);
  const emp = makeEmployee(1);
  await overtime.startSession(emp, null);
  await overtime.finishSession(emp);
  return emp;
}

test('persetujuan oleh karyawan biasa ditolak', async () => {
  const repo = makeFakeOvertimeRepo();
  await pendingSession(repo);
  await assert.rejects(
    () => makeApproval(repo).decide({ approver: makeEmployee(3, 'employee'), sessionId: 1, approve: true, envAdminIds: [] }),
    /admin\/atasan/
  );
});

test('self-approval ditolak', async () => {
  const repo = makeFakeOvertimeRepo();
  const emp = makeEmployee(1, 'supervisor');
  const { makeOvertime } = require('./helpers/overtime-fake');
  const overtime = makeOvertime(repo);
  await overtime.startSession(emp, null);
  await overtime.finishSession(emp);
  await assert.rejects(
    () => makeApproval(repo).decide({ approver: emp, sessionId: 1, approve: true, envAdminIds: [] }),
    /sendiri/
  );
});

test('persetujuan oleh supervisor valid; keputusan kedua ditolak (callback berulang)', async () => {
  const repo = makeFakeOvertimeRepo();
  await pendingSession(repo);
  const approval = makeApproval(repo);
  const sup = makeEmployee(2, 'supervisor');
  const res = await approval.decide({ approver: sup, sessionId: 1, approve: true, envAdminIds: [] });
  assert.strictEqual(res.status, 'approved');
  assert.strictEqual(res.payableMinutes, 90);
  await assert.rejects(() => approval.decide({ approver: sup, sessionId: 1, approve: true, envAdminIds: [] }), /sudah/);
});

test('penolakan tanpa menghitung durasi', async () => {
  const repo = makeFakeOvertimeRepo();
  await pendingSession(repo);
  const res = await makeApproval(repo).decide({
    approver: makeEmployee(2, 'admin'), sessionId: 1, approve: false, note: 'tanpa izin', envAdminIds: [],
  });
  assert.strictEqual(res.status, 'rejected');
  assert.strictEqual(res.actualMinutes, null);
});

test('admin env dapat menyetujui walau role employee', async () => {
  const repo = makeFakeOvertimeRepo();
  await pendingSession(repo);
  const res = await makeApproval(repo).decide({
    approver: makeEmployee(9, 'employee'), sessionId: 1, approve: true, envAdminIds: [1009],
  });
  assert.strictEqual(res.status, 'approved');
});
