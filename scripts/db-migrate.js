'use strict';
// Migration aman & dapat diulang: `node scripts/db-migrate.js`
// Membaca semua file database/migrations/*.sql (urut nama) dan mengeksekusinya
// satu-per-satu. File yang sudah diterapkan dicatat di tabel schema_migrations.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { loadEnv, assertMigrationTarget } = require('../src/config/env');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

(async () => {
  let conn;
  try {
    const cfg = loadEnv();
    assertMigrationTarget(cfg.db.database, cfg.nodeEnv);
    // Koneksi khusus migration dengan multipleStatements (file SQL internal terpercaya).
    // Pool aplikasi biasa TIDAK memakai multipleStatements — jangan pakai pool di sini.
    conn = await mysql.createConnection({
      host: cfg.db.host,
      port: cfg.db.port,
      user: cfg.db.user,
      password: cfg.db.password,
      database: cfg.db.database,
      multipleStatements: true,
      timezone: 'Z',
    });
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    const [applied] = await conn.query('SELECT filename FROM schema_migrations');
    const done = new Set(applied.map((r) => r.filename));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    if (!files.length) { console.log('Tidak ada migration.'); process.exit(0); }
    let ran = 0;
    for (const file of files) {
      if (done.has(file)) { console.log(`⏭️  ${file} (sudah diterapkan)`); continue; }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await conn.beginTransaction();
      try {
        await conn.query(sql);
        await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
        await conn.commit();
        console.log(`✅ ${file} diterapkan.`);
        ran++;
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw new Error(`File ${file}: ${err.message}`);
      }
    }
    console.log(ran ? `Selesai: ${ran} migration diterapkan.` : 'Semua migration sudah diterapkan.');
    await conn.end();
    process.exit(0);
  } catch (err) {
    console.error(`❌ Migration gagal: [${err.code || 'ERR'}] ${err.message}`);
    if (conn) await conn.end().catch(() => {});
    process.exit(1);
  }
})();
