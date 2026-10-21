'use strict';
const path = require('path');
// Muat .env dari root proyek secara eksplisit — tidak bergantung pada CWD
// proses (mis. server di-start dari direktori lain / script background).
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const REQUIRED_VARS = ['BOT_TOKEN', 'DB_HOST', 'DB_USER', 'DB_NAME'];
// DB_PASSWORD boleh string kosong (mis. root tanpa password di MySQL XAMPP lokal),
// tetapi variabelnya harus ada agar salah ketik nama variabel tetap terdeteksi.
const MUST_EXIST_VARS = [...REQUIRED_VARS, 'DB_PASSWORD'];

function parseAdminIds(raw) {
  if (!raw || !raw.trim()) return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number);
}

function loadEnv({ requireBotToken = true } = {}) {
  // BOT_TOKEN opsional hanya untuk Web Admin (token bisa diisi via UI Pengaturan;
  // bot tidak pernah di-start otomatis oleh web). Mode bot (src/app.js) tetap wajib.
  const requiredNow = requireBotToken ? REQUIRED_VARS : REQUIRED_VARS.filter((v) => v !== 'BOT_TOKEN');
  const mustExistNow = requireBotToken ? MUST_EXIST_VARS : MUST_EXIST_VARS.filter((v) => v !== 'BOT_TOKEN');
  const missing = mustExistNow.filter((k) => process.env[k] === undefined || process.env[k] === null);
  const empty = requiredNow.filter((k) => !String(process.env[k] ?? '').trim());
  const problems = [...new Set([...missing, ...empty])];
  if (problems.length > 0) {
    const err = new Error(`Konfigurasi environment wajib belum tersedia: ${problems.join(', ')}. Salin .env.example menjadi .env dan isi nilainya. (DB_PASSWORD boleh string kosong untuk MySQL lokal tanpa password.)`);
    err.code = 'ENV_VALIDATION';
    throw err;
  }
  const tz = process.env.APP_TIMEZONE || 'Asia/Jakarta';
  // Validasi timezone
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch (e) {
    const err = new Error(`APP_TIMEZONE tidak valid: "${tz}"`);
    err.code = 'ENV_VALIDATION';
    throw err;
  }
  const cfg = {
    botToken: process.env.BOT_TOKEN,
    adminTelegramIds: parseAdminIds(process.env.ADMIN_TELEGRAM_IDS),
    db: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 5),
    },
    timezone: tz,
    logLevel: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development',
    overtime: {
      minMinutes: Number(process.env.OVERTIME_MIN_MINUTES || 30),
      roundingMinutes: Number(process.env.OVERTIME_ROUNDING_MINUTES || 15),
      maxHoursPerDay: Number(process.env.OVERTIME_MAX_HOURS_PER_DAY || 8),
    },
  };
  if (cfg.adminTelegramIds.length === 0) {
    console.warn('[PERINGATAN] ADMIN_TELEGRAM_IDS kosong. Tidak ada admin awal. Set via environment di produksi.');
  }
  return cfg;
}

/** Batas nama database yang diizinkan untuk migrasi saat NODE_ENV=development. */
const DEV_ALLOWED_MIGRATION_DBS = ['lunifar_overtime_test'];

/**
 * Fail-safe migrasi: saat NODE_ENV=development, migrasi hanya boleh dijalankan
 * pada database testing yang diketahui, agar tidak salah sasaran ke DB produksi.
 * Produksi (NODE_ENV != development) tidak dibatasi di sini.
 */
function assertMigrationTarget(dbName, nodeEnv) {
  if (nodeEnv === 'development' && !DEV_ALLOWED_MIGRATION_DBS.includes(dbName)) {
    const err = new Error(
      `Migrasi ditolak: NODE_ENV=development hanya mengizinkan database testing ` +
      `(${DEV_ALLOWED_MIGRATION_DBS.join(', ')}), tetapi target adalah "${dbName}". ` +
      `Periksa DB_NAME di .env atau set NODE_ENV sesuai lingkungan.`
    );
    err.code = 'MIGRATION_TARGET';
    throw err;
  }
  return true;
}

/**
 * Guard khusus penulisan Web Admin (migration web / bootstrap akun).
 * Lebih ketat dari assertMigrationTarget: penulisan web di development
 * HANYA boleh ke database testing yang terdaftar. Produksi harus diberi
 * konfirmasi eksplisit via variabel env WEB_TARGET_CONFIRM=YES karena
 * nama database produksi tidak dapat diverifikasi otomatis dari sini.
 */
function assertWebWriteTarget(dbName, nodeEnv, confirmEnv) {
  if (nodeEnv === 'development') {
    if (!DEV_ALLOWED_MIGRATION_DBS.includes(dbName)) {
      const err = new Error(
        `Target penulisan web ditolak: NODE_ENV=development hanya mengizinkan ` +
        `database testing (${DEV_ALLOWED_MIGRATION_DBS.join(', ')}), target: "${dbName}".`
      );
      err.code = 'WEB_TARGET';
      throw err;
    }
    return true;
  }
  if (confirmEnv !== 'YES') {
    const err = new Error(
      `Target penulisan web di lingkungan "${nodeEnv}" memerlukan konfirmasi eksplisit ` +
      `env WEB_TARGET_CONFIRM=YES (verifikasi manual bahwa DB_NAME benar). Dibatalkan.`
    );
    err.code = 'WEB_TARGET';
    throw err;
  }
  return true;
}

module.exports = { loadEnv, parseAdminIds, assertMigrationTarget, assertWebWriteTarget, DEV_ALLOWED_MIGRATION_DBS };
