'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EmployeeService } = require('../src/services/employee.service');
const i18n = require('../src/i18n');
const { mainMenu } = require('../src/bot/keyboards');
const { formatMonthlyText, aggregateMonthly } = require('../src/services/payroll');
const { formatDailyRecap } = require('../src/services/overtime-input');
const { calendarKeyboard, formatDateId } = require('../src/services/calendar');

function makeFakeRepo() {
  const store = new Map();
  let nextId = 1;
  return {
    store,
    async findByTelegramId(id) { return store.get(id) || null; },
    async findById(id) { return [...store.values()].find((e) => e.id === Number(id)) || null; },
    async create({ telegramUserId, fullName, employeeNumber, department }) {
      const id = nextId++;
      store.set(telegramUserId, { id, telegram_user_id: telegramUserId, full_name: fullName, employee_number: employeeNumber, department, role: 'employee', status: 'active', is_active: 1, language: 'id' });
      return id;
    },
    async setLanguage(id, language) {
      const e = [...store.values()].find((x) => x.id === Number(id));
      if (e) { e.language = language; return true; }
      return false;
    },
    async setStatus() { return true; },
    async setRole() { return true; },
    async list() { return []; },
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

test('persistensi bahasa: pilihan tersimpan per user & bertahan', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  await svc.register({ telegramUserId: 1, fullName: 'A', department: 'X' });
  await svc.register({ telegramUserId: 2, fullName: 'B', department: 'Y' });
  const lang = await svc.setLanguage(1, 'vi');
  assert.strictEqual(lang, 'vi');
  const emp1 = await svc.requireActiveEmployee(1);
  const emp2 = await svc.requireActiveEmployee(2);
  assert.strictEqual(svc.getLanguage(emp1), 'vi');
  assert.strictEqual(svc.getLanguage(emp2), 'id'); // user lain tidak terpengaruh
});

test('persistensi bahasa: bahasa tak dikenal ditolak; default id', async () => {
  const repo = makeFakeRepo();
  const svc = makeService(repo);
  await svc.register({ telegramUserId: 5, fullName: 'C', department: 'Z' });
  await assert.rejects(() => svc.setLanguage(5, 'fr'));
  await assert.rejects(() => svc.setLanguage(5, 'zh-CN'));
  const emp = await svc.requireActiveEmployee(5);
  assert.strictEqual(svc.getLanguage(emp), 'id');
  assert.strictEqual(svc.getLanguage(null), 'id');
  assert.strictEqual(svc.getLanguage({ language: 'en' }), 'en');
});

test('menu berbahasa: label berubah, struktur & jumlah tombol tetap', () => {
  const idMenu = mainMenu('id');
  const viMenu = mainMenu('vi');
  const zhMenu = mainMenu('zh-TW');
  assert.notDeepStrictEqual(idMenu.keyboard, viMenu.keyboard);
  assert.ok(JSON.stringify(zhMenu).includes('輸入加班'));
  assert.strictEqual(mainMenu().keyboard.flat().length, 5); // default kompatibel
});

test('rekap bulanan & harian dalam 4 bahasa: nominal tidak berubah', () => {
  const rows = [{
    id: 1, status: 'completed',
    start_at: '2026-10-15T07:30:00+08:00',
    end_at: '2026-10-15T11:30:00+08:00',
    break_minutes: 30,
  }];
  const agg = aggregateMonthly(rows, 'Asia/Taipei');
  const texts = ['id', 'en', 'zh-TW', 'vi'].map((l) => formatMonthlyText(agg, 2026, 10, l));
  // Total nominal sama di semua bahasa.
  const cents = texts.map((tx) => /NT\$[\d.,-]+/.exec(tx.split('💰')[1])[0]);
  assert.strictEqual(new Set(cents).size, 1);
  assert.ok(texts[0].includes('Kategori 1'));
  assert.ok(texts[1].includes('Category 1'));
  assert.ok(texts[2].includes('類別 1'));
  assert.ok(texts[3].includes('Nhóm 1'));

  const recaps = ['id', 'en'].map((l) => formatDailyRecap(rows, 'Asia/Taipei', null, l));
  assert.ok(recaps[0].includes('Durasi: 3 jam 30 menit'));
  assert.ok(recaps[1].includes('Duration: 3 h 30 min'));
});

test('kalender berbahasa: nama hari & tombol Today/Cancel', () => {
  const zh = calendarKeyboard(2026, 10, 'zh-TW');
  assert.ok(zh[1].some((b) => b.text === '日'));
  assert.ok(zh[zh.length - 1].some((b) => b.text === '今天'));
  assert.strictEqual(formatDateId({ y: 2026, m: 10, d: 11 }, 'zh-TW'), '2026年10月11日');
  const idKb = calendarKeyboard(2026, 10, 'id');
  assert.deepStrictEqual(
    idKb.map((r) => r.map((b) => b.callback_data)),
    calendarKeyboard(2026, 10, 'vi').map((r) => r.map((b) => b.callback_data)),
    'callback kalender identik lintas bahasa'
  );
});
