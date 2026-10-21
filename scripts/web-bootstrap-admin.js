'use strict';

/**
 * Bootstrap akun admin web pertama (Tahap 2 — terintegrasi database).
 *
 * - Password dimasukkan INTERAKTIF (tidak lewat argumen CLI, tidak diecho).
 * - Tidak ada password default; tidak mencetak password/hash/kredensial DB.
 * - Guard target: NODE_ENV=development hanya menulis ke DB testing terdaftar;
 *   lingkungan lain butuh WEB_TARGET_CONFIRM=YES (verifikasi manual).
 * - Menolak username duplikat.
 *
 * Jalankan: node scripts/web-bootstrap-admin.js
 */

const readline = require('readline');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadEnv, assertWebWriteTarget } = require('../src/config/env');
const { WebUserRepository } = require('../src/web/web-user.repo');
const { BCRYPT_COST, USERNAME_RE } = require('../src/web/routes/auth');

function askVisible(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

/** Prompt password tanpa echo (raw mode). Ctrl+C untuk batal. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    let value = '';
    const onData = (buf) => {
      const ch = buf.toString('utf8');
      if (ch === '\r' || ch === '\n' || ch === '\r\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        return resolve(value);
      }
      if (ch === '\u0003') { // Ctrl+C
        stdin.setRawMode(false);
        process.stdout.write('\n');
        return reject(new Error('Dibatalkan.'));
      }
      if (ch === '\u007f' || ch === '\b') { // backspace
        value = value.slice(0, -1);
        return;
      }
      value += ch;
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/** Kebijakan minimal: 12+ karakter, mengandung huruf & angka. */
function validatePasswordStrength(password) {
  if (typeof password !== 'string' || password.length < 12) {
    return 'Password minimal 12 karakter.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password harus mengandung huruf dan angka.';
  }
  return null;
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST);
}

/**
 * Buat akun admin via repository. Tidak pernah mengembalikan/mencetak hash.
 * Melempar Error dengan code:
 *  - 'USERNAME_INVALID'
 *  - 'PASSWORD_WEAK'
 *  - 'ER_DUP_ENTRY' / 'USERNAME_TAKEN' saat duplikat
 */
async function createAdminUser(repo, usernameRaw, password) {
  if (!repo || typeof repo.create !== 'function' || typeof repo.findByUsername !== 'function') {
    throw new Error('Repository web_users tidak valid.');
  }
  const username = String(usernameRaw || '').trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    const err = new Error('Username tidak valid (3-64 karakter: huruf, angka, titik, garis).');
    err.code = 'USERNAME_INVALID';
    throw err;
  }
  const weak = validatePasswordStrength(password);
  if (weak) {
    const err = new Error(weak);
    err.code = 'PASSWORD_WEAK';
    throw err;
  }
  const existing = await repo.findByUsername(username);
  if (existing) {
    const err = new Error(`Username "${username}" sudah terdaftar.`);
    err.code = 'ER_DUP_ENTRY';
    throw err;
  }
  const passwordHash = await hashPassword(password);
  await repo.create({ username, passwordHash });
  return { username };
}

async function main() {
  // Guard target SEBELUM koneksi dibuka: gagal cepat tanpa menyentuh DB.
  const cfg = loadEnv();
  assertWebWriteTarget(cfg.db.database, cfg.nodeEnv, process.env.WEB_TARGET_CONFIRM);

  const username = (await askVisible('Username admin: ')).trim();
  const password = await askHidden('Password (tidak tampil saat diketik): ');
  if (validatePasswordStrength(password)) {
    console.error(`❌ ${validatePasswordStrength(password)}`);
    process.exit(1);
  }
  const confirm = await askHidden('Ulangi password: ');
  if (confirm !== password) {
    console.error('❌ Password tidak sama.');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: cfg.db.host,
    port: cfg.db.port,
    user: cfg.db.user,
    password: cfg.db.password,
    database: cfg.db.database,
    connectionLimit: 2,
    timezone: 'Z',
  });
  try {
    const repo = new WebUserRepository(pool);
    const { username: norm } = await createAdminUser(repo, username, password);
    console.log(`\n✅ Admin web "${norm}" dibuat di database target.`);
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}

module.exports = { askHidden, validatePasswordStrength, hashPassword, createAdminUser };
