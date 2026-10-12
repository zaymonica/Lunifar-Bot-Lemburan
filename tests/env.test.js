'use strict';
const test = require('node:test');
const assert = require('node:assert');

process.env.BOT_TOKEN = 'x';
process.env.DB_HOST = 'h';
process.env.DB_USER = 'u';
process.env.DB_PASSWORD = 'p';
process.env.DB_NAME = 'd';

const { loadEnv, parseAdminIds } = require('../src/config/env');

test('parseAdminIds menerima daftar digit & mengabaikan yang tidak valid', () => {
  assert.deepStrictEqual(parseAdminIds('123, 456,abc,'), [123, 456]);
  assert.deepStrictEqual(parseAdminIds(''), []);
  assert.deepStrictEqual(parseAdminIds(undefined), []);
});

test('loadEnv valid dengan env lengkap', () => {
  process.env.ADMIN_TELEGRAM_IDS = '123';
  const savedTz = process.env.APP_TIMEZONE;
  process.env.APP_TIMEZONE = 'Asia/Jakarta';
  const cfg = loadEnv();
  assert.strictEqual(cfg.timezone, 'Asia/Jakarta');
  assert.deepStrictEqual(cfg.adminTelegramIds, [123]);
  assert.strictEqual(cfg.overtime.minMinutes, 30);
  if (savedTz === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = savedTz;
});

test('loadEnv gagal jika wajib kosong', () => {
  const saved = process.env.BOT_TOKEN;
  delete process.env.BOT_TOKEN;
  assert.throws(() => loadEnv(), /BOT_TOKEN/);
  process.env.BOT_TOKEN = saved;
});

test('DB_PASSWORD kosong diterima (MySQL lokal root tanpa password)', () => {
  const saved = process.env.DB_PASSWORD;
  process.env.DB_PASSWORD = '';
  const cfg = loadEnv();
  assert.strictEqual(cfg.db.password, '');
  process.env.DB_PASSWORD = saved;
});

test('DB_PASSWORD tidak boleh tidak ada (variabel hilang tetap terdeteksi)', () => {
  const saved = process.env.DB_PASSWORD;
  delete process.env.DB_PASSWORD;
  assert.throws(() => loadEnv(), /DB_PASSWORD/);
  process.env.DB_PASSWORD = saved;
});

test('variabel wajib lain tetap divalidasi meski password kosong', () => {
  const savedUser = process.env.DB_USER;
  process.env.DB_PASSWORD = '';
  process.env.DB_USER = '';
  assert.throws(() => loadEnv(), /DB_USER/);
  process.env.DB_USER = savedUser;
});

const { assertMigrationTarget } = require('../src/config/env');

test('guard migrasi: development hanya mengizinkan database testing', () => {
  assert.strictEqual(assertMigrationTarget('lunifar_overtime_test', 'development'), true);
  assert.throws(() => assertMigrationTarget('lunifar_overtime', 'development'), /Migrasi ditolak/);
  assert.throws(() => assertMigrationTarget('production_db', 'development'), /MIGRATION_TARGET|Migrasi ditolak/);
});

test('guard migrasi: produksi tidak dibatasi oleh guard development', () => {
  assert.strictEqual(assertMigrationTarget('nama_db_prod', 'production'), true);
});

test('loadEnv gagal jika timezone tidak valid', () => {
  const savedTz = process.env.APP_TIMEZONE;
  process.env.APP_TIMEZONE = 'Bukan/Zona';
  assert.throws(() => loadEnv(), /APP_TIMEZONE/);
  if (savedTz === undefined) delete process.env.APP_TIMEZONE; else process.env.APP_TIMEZONE = savedTz;
});
