'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { encryptText, decryptText, deriveKey } = require('../../src/web/crypto');
const { WebSettingsStore } = require('../../src/web/settings-store');
const { BotLifecycle } = require('../../src/web/bot-lifecycle');
const { createWebApp } = require('../../src/web/index');
const { createInMemoryAccountStore } = require('../../src/web/account-store');

const KEY = '0123456789abcdef0123456789abcdef'; // 32 char, bukan hex → scrypt path

// ---- crypto: AES-256-GCM ----
test('crypto: roundtrip encrypt/decrypt; ciphertext bukan plaintext', () => {
  const token = '123456:ABC-DEF_secret_token';
  const enc = encryptText(token, KEY);
  assert.match(enc, /^v1\./);
  assert.ok(!enc.includes(token));
  assert.strictEqual(decryptText(enc, KEY), token);
});

test('crypto: kunci salah gagal dekripsi; kunci lemah ditolak', () => {
  const enc = encryptText('rahasia', KEY);
  assert.throws(() => decryptText(enc, 'kunci-lain-yang-berbeda-16'));
  assert.throws(() => deriveKey('pendek'), /WEB_SETTINGS_KEY/);
  assert.throws(() => deriveKey(null), /WEB_SETTINGS_KEY/);
});

// ---- settings-store ----
function makeMockRepo() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async set(k, v) { store.set(k, v); },
    _store: store,
  };
}

test('settings-store: key tidak diset → set ditolak fail-closed, status disabled', async () => {
  const s = new WebSettingsStore({ settingsRepo: makeMockRepo(), settingsKey: null });
  await assert.rejects(() => s.setBotToken('123456:ABC-DEF_abcdefghijklmnopqrstuvwxyz123'), /WEB_SETTINGS_KEY/);
  assert.deepStrictEqual(await s.getBotTokenStatus(), { enabled: false, configured: false, masked: null });
  assert.strictEqual(await s.getBotToken(), null);
  assert.strictEqual(s.tokenEnabled, false);
});

test('settings-store: key valid → tersimpan terenkripsi, status masked, tidak ada plaintext', async () => {
  const repo = makeMockRepo();
  const s = new WebSettingsStore({ settingsRepo: repo, settingsKey: KEY });
  const token = '123456:ABC-DEF_abcdefghijklmnopqrstuvwxyz123';
  await s.setBotToken(token);
  const stored = repo._store.get('web.bot_token_enc');
  assert.ok(stored && stored.startsWith('v1.'));
  assert.ok(!stored.includes(token));
  assert.strictEqual(await s.getBotToken(), token);
  const st = await s.getBotTokenStatus();
  assert.strictEqual(st.configured, true);
  assert.match(st.masked, /^\*+z123$/);
  // Ciphertext rusak → status configured=false dengan penanda error, tanpa throw.
  repo._store.set('web.bot_token_enc', 'v1.aaaa.aaaa.aaaa');
  const broken = await s.getBotTokenStatus();
  assert.strictEqual(broken.configured, false);
  await s.clearBotToken();
  assert.strictEqual((await s.getBotTokenStatus()).configured, false);
});

// ---- BotLifecycle: tanpa token → gagal start tanpa state palsu ----
function makeLifecycle() {
  return new BotLifecycle({
    config: { botToken: null, logLevel: 'error' },
    services: {},
    settingsStore: null,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

test('lifecycle: start tanpa token gagal; state kembali stopped; lastError terisi', async () => {
  const lc = makeLifecycle();
  await assert.rejects(() => lc.start(), /Token bot belum dikonfigurasi/);
  assert.strictEqual(lc.state, 'stopped');
  assert.match(lc.status.error, /Token bot belum dikonfigurasi/);
  assert.strictEqual(lc.bot, null);
  // start berikutnya tetap boleh (tidak terkunci di state error).
  await assert.rejects(() => lc.start(), /Token bot belum dikonfigurasi/);
  assert.strictEqual(lc.state, 'stopped');
});

test('lifecycle: start saat stopping/starting ditolak (cegah dua instance polling)', async () => {
  const lc = makeLifecycle();
  lc.state = 'stopping';
  await assert.rejects(() => lc.start(), /transisi/);
  lc.state = 'starting';
  await assert.rejects(() => lc.start(), /transisi/);
});

// ---- Regresi: resolveSettingsKey (startup validation, tanpa nilai dicetak) ----
const { WebSettingsStore: WSS } = require('../../src/web/settings-store');

test('resolveSettingsKey: tidak di-set → warning jelas, key null (fail-closed)', () => {
  const r = WSS.resolveSettingsKey(undefined);
  assert.strictEqual(r.key, null);
  assert.match(r.warning, /WEB_SETTINGS_KEY/);
  assert.match(r.warning, /openssl rand -hex 32/);
});

test('resolveSettingsKey: key lemah → gagal cepat; key valid → diterima', () => {
  assert.throws(() => WSS.resolveSettingsKey('pendek'), /WEB_SETTINGS_KEY/);
  const ok = WSS.resolveSettingsKey('0123456789abcdef0123456789abcdef');
  assert.strictEqual(ok.key, '0123456789abcdef0123456789abcdef');
  assert.strictEqual(ok.warning, null);
});

// ---- Regresi: CSRF pada mutasi ----
test('CSRF: token salah/kadaluarsa → 403; token sesi benar → mutasi 200', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    const csrf = await login(h);
    // Token stale/palsu harus tetap ditolak 403 (tidak ada bypass).
    const bad1 = await h.req('POST', '/api/bot/start', {}, { 'X-CSRF-Token': 'deadbeef'.repeat(8) });
    assert.strictEqual(bad1.status, 403);
    const bad2 = await h.req('DELETE', '/api/settings/bot-token', undefined, { 'X-CSRF-Token': '' });
    assert.strictEqual(bad2.status, 403);
    // Token sesi terbaru tetap diterima (alur dashboard: refresh dari /api/auth/me).
    const me = await h.req('GET', '/api/auth/me');
    const fresh = (await me.json()).csrfToken;
    assert.strictEqual(fresh, csrf, 'token sesi stabil selama sesi sama');
    const ok = await h.req('POST', '/api/bot/stop', {}, { 'X-CSRF-Token': fresh });
    assert.strictEqual(ok.status, 409); // 409 = lolos CSRF (ditolak karena state), bukan 403
  });
});

test('dashboard HTML: meta csrf-token disematkan dan valid untuk mutasi', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    await login(h);
    const page = await h.req('GET', '/web/dashboard');
    assert.strictEqual(page.status, 200);
    const html = await page.text();
    const m = /meta name="csrf-token" content="([0-9a-f]+)"/.exec(html);
    assert.ok(m, 'meta csrf-token harus ada di dashboard');
    assert.ok(!html.includes('__CSRF_TOKEN__'), 'placeholder harus terganti');
    // Token dari meta langsung valid untuk mutasi (tanpa /api/auth/me dulu).
    const res = await h.req('POST', '/api/bot/stop', {}, { 'X-CSRF-Token': m[1] });
    assert.strictEqual(res.status, 409); // lolos CSRF; 409 karena bot tidak running
  });
});

// ---- Regresi: env loading dari root .env tidak tergantung CWD ----
test('env: modul config/env memuat .env dari root proyek (path eksplisit)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'config', 'env.js'), 'utf8');
  assert.match(src, /dotenv'\)\.config\(\{ path: path\.join\(__dirname/);
});
function makeApiDeps() {
  return {
    config: { timezone: 'Asia/Jakarta', adminTelegramIds: [], botToken: '', overtime: {} },
    employeeRepo: { async countByStatus() { return []; }, async list() { return []; } },
    overtimeRepo: { async countByStatus() { return []; } },
    approvalService: { async listPending() { return []; } },
    reportService: { async recap() { return []; } },
    settingsStore: new WebSettingsStore({ settingsRepo: makeMockRepo(), settingsKey: null }),
    adminAudit: { repo: { async list() { return []; } }, logger: async () => {} },
    botLifecycle: makeLifecycle(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function makeApp(apiDeps) {
  const passwordHash = bcrypt.hashSync('correct-horse-42', 4);
  return createWebApp({
    accountStore: createInMemoryAccountStore([{ id: 1, username: 'admin', passwordHash }]),
    sessionSecret: 'test-secret-0123456789abcdef0123456789abcdef',
    env: { NODE_ENV: 'development' },
    apiDeps,
  });
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const jar = new Map();
  const h = {
    cookieHeader() { return [...jar.keys()].map((k) => `${k}=${jar.get(k)}`).join('; '); },
    storeCookies(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    async req(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
          ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      this.storeCookies(res);
      return res;
    },
  };
  try {
    return await fn(h);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function login(h) {
  const page = await h.req('GET', '/web/login');
  const html = await page.text();
  const csrf = /name="csrf-token" content="([0-9a-f]+)"/.exec(html)[1];
  const res = await h.req('POST', '/api/auth/login', { username: 'admin', password: 'correct-horse-42' }, { 'X-CSRF-Token': csrf });
  assert.strictEqual(res.status, 200, 'login harus sukses');
  const me = await h.req('GET', '/api/auth/me');
  const j = await me.json();
  h.csrf = (j.data && j.data.csrfToken) || j.csrfToken || csrf;
  return h.csrf;
}

test('API: simpan token tanpa WEB_SETTINGS_KEY → 400 pesan jelas, bukan 500, tanpa echo token', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    await login(h);
    const token = '123456:ABC-DEF_abcdefghijklmnopqrstuvwxyz123';
    const res = await h.req('POST', '/api/settings/bot-token', { token });
    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /WEB_SETTINGS_KEY/);
    assert.ok(!JSON.stringify(body).includes(token));
    // Hapus token saat store nonaktif → 400 (bukan sukses palsu).
    const del = await h.req('DELETE', '/api/settings/bot-token');
    assert.strictEqual(del.status, 400);
    assert.match((await del.json()).error, /WEB_SETTINGS_KEY/);
  });
});

test('API: /api/bot tanpa token → state stopped (bukan error), tokenConfigured false', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    await login(h);
    // Gagal start (tanpa token) → 409 dengan pesan jelas, tanpa detail internal.
    const start = await h.req('POST', '/api/bot/start', {});
    assert.strictEqual(start.status, 409);
    const startBody = await start.json();
    assert.strictEqual(startBody.ok, false);
    assert.match(startBody.error, /Token bot belum dikonfigurasi/);
    const res = await h.req('GET', '/api/bot');
    assert.strictEqual(res.status, 200);
    const d = (await res.json()).data;
    assert.strictEqual(d.state, 'stopped');
    assert.strictEqual(d.tokenConfigured, false);
    assert.ok(d.error && /Token bot belum dikonfigurasi/.test(d.error));
  });
});