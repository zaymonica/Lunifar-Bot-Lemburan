'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EmployeeService } = require('../src/services/employee.service');

function makeFakeRepo() {
  const store = new Map();
  let nextId = 1;
  return {
    store,
    async findByTelegramId(id) { return store.get(id) || null; },
    async findById(id) { return [...store.values()].find((e) => e.id === Number(id)) || null; },
    async create({ telegramUserId, fullName, employeeNumber, department }) {
      const id = nextId++;
      store.set(telegramUserId, { id, telegram_user_id: telegramUserId, full_name: fullName, employee_number: employeeNumber, department, role: 'employee', status: 'active', is_active: 1 });
      return id;
    },
    async setStatus(id, status, isActive) {
      const e = [...store.values()].find((x) => x.id === Number(id));
      if (e) { e.status = status; e.is_active = isActive ? 1 : 0; return true; }
      return false;
    },
    async setRole(id, role) { const e = [...store.values()].find((x) => x.id === Number(id)); if (e) { e.role = role; return true; } return false; },
    async list({ search }) { return [...store.values()].filter((e) => !search || e.full_name.includes(search)); },
    async countByStatus() { return []; },
  };
}

function makeService(repo) {
  return new EmployeeService({
    employeeRepo: repo,
    auditRepo: { async log() {} },
    notificationService: { async notifyAdmins() {}, async sendTo() {} },
  });
}

test('registrasi langsung aktif tanpa persetujuan admin', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  const res = await svc.register({ telegramUserId: 111, fullName: 'Budi Santoso', department: 'Produksi' });
  assert.strictEqual(res.status, 'active');
  const emp = await svc.requireActiveEmployee(111);
  assert.strictEqual(emp.status, 'active');
});

test('registrasi duplikat ditolak', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  await svc.register({ telegramUserId: 111, fullName: 'Budi', department: 'IT' });
  await assert.rejects(() => svc.register({ telegramUserId: 111, fullName: 'Budi', department: 'IT' }), /terdaftar/);
});

test('status lama pending diaktifkan otomatis saat requireActiveEmployee', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  const r = await svc.register({ telegramUserId: 111, fullName: 'Budi', department: 'IT' });
  await repo.setStatus(r.employeeId, 'pending', false); // simulasi data lama
  const emp = await svc.requireActiveEmployee(111);
  assert.strictEqual(emp.status, 'active');
});

test('registrasi ditolak sebelumnya bisa daftar ulang dan langsung aktif', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  const r = await svc.register({ telegramUserId: 111, fullName: 'Budi', department: 'IT' });
  await repo.setStatus(r.employeeId, 'rejected', false);
  await assert.rejects(() => svc.requireActiveEmployee(111), /ditolak/);
  const r2 = await svc.register({ telegramUserId: 111, fullName: 'Budi', department: 'IT' });
  assert.strictEqual(r2.status, 'active');
  const emp = await svc.requireActiveEmployee(111);
  assert.strictEqual(emp.status, 'active');
});

test('karyawan nonaktif tidak boleh lembur', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  const r = await svc.register({ telegramUserId: 111, fullName: 'Budi', department: 'IT' });
  await svc.setActive(999, r.employeeId, false);
  await assert.rejects(() => svc.requireActiveEmployee(111), /tidak aktif/);
});

test('validasi input registrasi', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  await assert.rejects(() => svc.register({ telegramUserId: 111, fullName: '', department: 'IT' }), /Nama/);
  await assert.rejects(() => svc.register({ telegramUserId: 111, fullName: 'A'.repeat(150), department: 'IT' }), /maksimal/);
  await assert.rejects(() => svc.register({ telegramUserId: -1, fullName: 'Budi', department: 'IT' }), /tidak valid/);
});

test('isAdmin via env dan via role', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  assert.strictEqual(await svc.isAdmin(777, [777]), true);
  const r = await svc.register({ telegramUserId: 888, fullName: 'Boss', department: 'IT' });
  assert.strictEqual(await svc.isAdmin(888, [777]), false);
  await repo.setRole(r.employeeId, 'admin');
  assert.strictEqual(await svc.isAdmin(888, [777]), true);
});
