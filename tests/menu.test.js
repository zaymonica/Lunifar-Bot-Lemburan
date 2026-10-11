'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { mainMenu } = require('../src/bot/keyboards');

test('menu utama hanya berisi 5 tombol tanpa admin / selesai lembur', () => {
  const buttons = mainMenu().keyboard.flat();
  assert.deepStrictEqual([...buttons].sort(), [
    '📝 INPUT LEMBUR',
    '📋 Status Lembur Saya',
    '📁 Riwayat Lembur',
    '👤 Profil Saya',
    '❓ Bantuan',
  ].sort());
  const raw = JSON.stringify(mainMenu());
  assert.ok(!raw.includes('Panel Admin'));
  assert.ok(!raw.includes('Selesai Lembur'));
  assert.ok(!('adminMenu' in require('../src/bot/keyboards')));
});
