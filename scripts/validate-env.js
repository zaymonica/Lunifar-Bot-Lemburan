'use strict';
// Validasi environment tanpa memulai bot: `node scripts/validate-env.js`
require('dotenv').config();
const { loadEnv } = require('../src/config/env');

try {
  const cfg = loadEnv();
  const mask = (v) => (v === undefined || v === null ? '<tidak diset>' : v === '' ? '<kosong — tanpa password>' : '<terisi>');
  console.log('✅ Konfigurasi environment valid.');
  console.log(`  NODE_ENV            = ${cfg.nodeEnv}`);
  console.log(`  APP_TIMEZONE        = ${cfg.timezone}`);
  console.log(`  DB_HOST             = ${cfg.db.host}`);
  console.log(`  DB_PORT             = ${cfg.db.port}`);
  console.log(`  DB_NAME             = ${cfg.db.database}`);
  console.log(`  DB_PASSWORD         = ${mask(cfg.db.password)}`);
  console.log(`  ADMIN_TELEGRAM_IDS  = ${cfg.adminTelegramIds.length} ID terdaftar`);
  console.log(`  Overtime policy     = min ${cfg.overtime.minMinutes}m, pembulatan ${cfg.overtime.roundingMinutes}m`);
  process.exit(0);
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
