'use strict';
// Pemeriksaan koneksi database: `node scripts/db-check.js`
require('dotenv').config();
const { loadEnv } = require('../src/config/env');
const { createPool } = require('../src/config/database');

(async () => {
  try {
    const cfg = loadEnv({ requireBotToken: false });
    const pool = createPool(cfg.db);
    const [rows] = await pool.query('SELECT VERSION() AS v, UTC_TIMESTAMP() AS utc_now');
    console.log(`✅ Koneksi OK — MySQL/MariaDB versi: ${rows[0].v}, UTC server: ${rows[0].utc_now}`);
    const [tables] = await pool.query("SHOW TABLES LIKE 'employees'");
    if (!tables.length) {
      console.log('⚠️ Tabel belum ada. Jalankan: npm run db:migrate');
    } else {
      console.log('✅ Tabel employees ditemukan.');
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(`❌ Koneksi database gagal: [${err.code || 'ERR'}] ${err.message}`);
    console.error('Periksa DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME di .env');
    process.exit(1);
  }
})();
