'use strict';
const test = require('node:test');
const assert = require('node:assert');
const i18n = require('../src/i18n');
const idCat = require('../src/i18n/catalogs/id');

test('katalog: 4 bahasa tersedia dengan key identik', () => {
  const langs = ['id', 'en', 'zh-TW', 'vi'];
  const ref = Object.keys(idCat.keys).sort();
  assert.ok(ref.length > 150, 'katalog id harus lengkap');
  for (const l of langs) {
    const keys = Object.keys(i18n.CATALOGS[l].keys).sort();
    assert.deepStrictEqual(keys, ref, `katalog ${l} harus punya key yang sama dengan id`);
    assert.strictEqual(i18n.CATALOGS[l].months.length, 12);
    assert.strictEqual(i18n.CATALOGS[l].days.length, 7);
  }
});

test('fallback: bahasa tak dikenal & key tak dikenal tidak melempar error', () => {
  assert.strictEqual(i18n.normalizeLang('xx'), 'id');
  assert.strictEqual(i18n.normalizeLang(null), 'id');
  assert.strictEqual(i18n.normalizeLang('zh-TW'), 'zh-TW');
  assert.strictEqual(i18n.t('id', 'key.tidak.ada'), 'key.tidak.ada');
  assert.strictEqual(i18n.t('xx', 'help.title'), i18n.t('id', 'help.title'));
});

test('interpolasi parameter: nama, tanggal, durasi, uang', () => {
  assert.strictEqual(i18n.t('id', 'start.welcomeBack', { name: 'Budi' }), 'Selamat datang kembali, Budi!');
  assert.strictEqual(i18n.formatDuration(90, 'id'), '1 jam 30 menit');
  assert.strictEqual(i18n.formatDuration(90, 'en'), '1 h 30 min');
  assert.strictEqual(i18n.formatDuration(45, 'zh-TW'), '45 分鐘');
  assert.strictEqual(i18n.formatDuration(45, 'vi'), '45 phút');
  assert.strictEqual(i18n.formatDuration(120, 'id'), '2 jam');
  assert.strictEqual(i18n.formatDate('id', { y: 2026, m: 10, d: 11 }), '11 Oktober 2026');
  assert.strictEqual(i18n.formatDate('en', { y: 2026, m: 10, d: 11 }), 'October 11, 2026');
  assert.strictEqual(i18n.formatDate('zh-TW', { y: 2026, m: 10, d: 11 }), '2026年10月11日');
  assert.strictEqual(i18n.formatDate('vi', { y: 2026, m: 10, d: 11 }), '11 tháng 10 năm 2026');
});

test('bahasa tradisional: aksara Mandarin menggunakan tradisional (bukan sederhana)', () => {
  const zh = i18n.CATALOGS['zh-TW'].keys;
  assert.ok(zh['menu.history'].includes('紀錄'));
  assert.ok(!/[记录]/.test(JSON.stringify(zh)), 'tidak boleh ada aksara sederhana 记/录');
});

test('trError: pemetaan pesan error Indonesia → bahasa target', () => {
  assert.strictEqual(
    i18n.trError('en', 'Anda sudah terdaftar.'),
    'You are already registered.'
  );
  assert.strictEqual(
    i18n.trError('id', 'Format jam harus HH:MM (00:00-23:59), contoh: 16:30.'),
    'Format jam harus HH:MM (00:00-23:59), contoh: 16:30.'
  );
  assert.strictEqual(
    i18n.trError('en', 'Catatan dengan status "pending" tidak dapat diedit.'),
    'A record with status "pending" cannot be edited.'
  );
  assert.strictEqual(
    i18n.trError('zh-TW', 'Nama lengkap wajib diisi.'),
    'Nama lengkap為必填。'
  );
  // Pesan tak terdaftar dikembalikan apa adanya (aman).
  assert.strictEqual(i18n.trError('en', 'Pesan misterius.'), 'Pesan misterius.');
});

test('pemilihan bahasa: keyboard memakai callback stabil lang:<code>', () => {
  const { languageKeyboard } = require('../src/bot/handlers/common');
  const kb = languageKeyboard();
  assert.strictEqual(kb.inline_keyboard.length, 4);
  const data = kb.inline_keyboard.map((row) => row[0].callback_data);
  assert.deepStrictEqual(data, ['lang:id', 'lang:en', 'lang:zh-TW', 'lang:vi']);
});

test('callback bisnis tetap stabil & independen bahasa', () => {
  const { mainMenu } = require('../src/bot/keyboards');
  // Menu berbahasa: 5 tombol lama + 1 tombol 🌐 Bahasa (label berbeda per bahasa,
  // tanpa callback_data — reply keyboard). Legacy mainMenu() tetap 5 tombol.
  for (const lang of ['id', 'en', 'zh-TW', 'vi']) {
    const kb = mainMenu(lang);
    assert.strictEqual(kb.keyboard.flat().length, 6);
    assert.strictEqual(kb.keyboard.flat()[5], require('../src/i18n').t(lang, 'menu.language'));
  }
  assert.strictEqual(mainMenu().keyboard.flat().length, 5);
  assert.strictEqual(JSON.stringify(mainMenu('vi')), JSON.stringify(mainMenu('vi')));
});

test('kompatibilitas tombol lama: label Indonesia tetap ada di semua varian label', () => {
  const { ALL_LABELS } = require('../src/bot/keyboards');
  for (const label of ['📝 INPUT LEMBUR', '📋 Status Lembur Saya', '📁 Riwayat Lembur', '👤 Profil Saya', '❓ Bantuan']) {
    assert.ok(ALL_LABELS.includes(label), `label lama ${label} harus tetap dikenali`);
  }
});
