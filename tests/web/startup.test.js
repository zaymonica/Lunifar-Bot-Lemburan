'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'x';
process.env.DB_HOST = process.env.DB_HOST || 'h';
process.env.DB_USER = process.env.DB_USER || 'u';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'p';
process.env.DB_NAME = process.env.DB_NAME || 'd';

const { loadEnv } = require('../../src/config/env');

test('loadEnv: BOT_TOKEN opsional saat requireBotToken=false (mode Web Admin)', () => {
  const saved = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    DB_HOST: process.env.DB_HOST,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
  };
  try {
    // Set eksplisit agar hermetik terhadap konkurensi file tes lain.
    process.env.DB_HOST = 'h';
    process.env.DB_USER = 'u';
    process.env.DB_PASSWORD = 'p';
    process.env.DB_NAME = 'd';
    delete process.env.BOT_TOKEN;
    const cfg = loadEnv({ requireBotToken: false });
    assert.strictEqual(cfg.botToken, undefined);
    assert.strictEqual(cfg.db.database, 'd');
    // Default (bot mode) tetap mewajibkan BOT_TOKEN.
    assert.throws(() => loadEnv(), /BOT_TOKEN/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('loadEnv Web Admin tetap mewajibkan DB_USER; SESSION_SECRET tetap divalidasi web config', () => {
  const saved = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    DB_HOST: process.env.DB_HOST,
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME,
  };
  try {
    process.env.BOT_TOKEN = 'x';
    process.env.DB_HOST = 'h';
    process.env.DB_PASSWORD = 'p';
    process.env.DB_NAME = 'd';
    delete process.env.DB_USER;
    assert.throws(() => loadEnv({ requireBotToken: false }), /DB_USER/);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  const { createWebConfig } = require('../../src/web/config');
  assert.throws(() => createWebConfig({}), /SESSION_SECRET/);
});

test('npm run web terdaftar dan tetap menunjuk src/web/server.js; npm start tidak berubah', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.strictEqual(pkg.scripts.web, 'node src/web/server.js');
  assert.strictEqual(pkg.scripts.start, 'node src/app.js');
});

test('server.js: default bind loopback + port 3001, tanpa migrasi otomatis', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'web', 'server.js'), 'utf8');
  assert.match(src, /process\.env\.WEB_PORT \|\| 3001/);
  assert.match(src, /WEB_HOST \|\| '127\.0\.0\.1'/);
  assert.match(src, /requireBotToken: false/);
  // Tidak ada pemanggilan migration/bootstrap di jalur startup.
  assert.ok(!/db-migrate|db:migrate|runMigrations?\(/.test(src));
});