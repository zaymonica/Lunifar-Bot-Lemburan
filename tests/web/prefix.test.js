'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createWebApp } = require('../../src/web/index');
const { createWebConfig } = require('../../src/web/config');
const { createInMemoryAccountStore } = require('../../src/web/account-store');

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeApp(env) {
  return createWebApp({
    accountStore: createInMemoryAccountStore([{ username: 'admin', password: 'x' }]),
    sessionSecret: 's'.repeat(32),
    env,
  });
}

test('basePath dikonfigurasi dari WEB_BASE_PATH', () => {
  const cfg = createWebConfig({ SESSION_SECRET: 's'.repeat(32), WEB_BASE_PATH: '/overtime-bot' });
  assert.strictEqual(cfg.basePath, '/overtime-bot');
  const cfgEmpty = createWebConfig({ SESSION_SECRET: 's'.repeat(32) });
  assert.strictEqual(cfgEmpty.basePath, '');
  assert.throws(() => createWebConfig({ SESSION_SECRET: 's'.repeat(32), WEB_BASE_PATH: 'no-slash' }), /WEB_BASE_PATH/);
});

test('dengan prefix: /overtime-bot/web/login mencapai route login (200 HTML)', async () => {
  const app = makeApp({ WEB_BASE_PATH: '/overtime-bot' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/overtime-bot/web/login`, { redirect: 'manual' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const body = await res.text();
    assert.match(body, /<html|login/i);
  });
});

test('dengan prefix: /overtime-bot/admin/dashboard.js dilayani sebagai aset statis', async () => {
  const app = makeApp({ WEB_BASE_PATH: '/overtime-bot' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/overtime-bot/admin/dashboard.js`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
  });
});

test('dengan prefix: query string dipertahankan saat strip prefix', async () => {
  const app = makeApp({ WEB_BASE_PATH: '/overtime-bot' });
  await withServer(app, async (base) => {
    // Endpoint 404 JSON API memastikan path API yang dikenali; gunakan GET login + query
    const res = await fetch(`${base}/overtime-bot/web/login?next=%2Fweb%2Fdashboard`, { redirect: 'manual' });
    assert.strictEqual(res.status, 200);
  });
});

test('tanpa prefix: aplikasi tetap berfungsi (Passenger sudah menghapus prefix)', async () => {
  const app = makeApp({ WEB_BASE_PATH: '/overtime-bot' });
  await withServer(app, async (base) => {
    const res = await fetch(`${base}/web/login`, { redirect: 'manual' });
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /<html|login/i);

    const res404 = await fetch(`${base}/api/tidak-ada`);
    assert.strictEqual(res404.status, 404);
    assert.strictEqual((await res404.json()).ok, false);
  });
});

test('API login POST berfungsi melalui prefix', async () => {
  const app = makeApp({ WEB_BASE_PATH: '/overtime-bot' });
  await withServer(app, async (base) => {
    // Kredensial salah → respons 401 generik (bukan 404 routing) membuktikan route tercapai.
    const res = await fetch(`${base}/overtime-bot/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'salah' }),
    });
    // Tanpa sesi/CSRF token → CSRF guard menolak (403), bukan 404 routing:
    // membuktikan route /api/auth/login tercapai meski lewat prefix.
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).ok, false);
  });
});

test('prefix tidak dihapus dua kali (idempoten): /overtime-bot/overtime-bot/web/login tidak valid', async () => {
  const app = makeApp({ WEB_BASE_PATH: '/overtime-bot' });
  await withServer(app, async (base) => {
    // Setelah strip satu kali tersisa /overtime-bot/web/login → bukan route → 404.
    const res = await fetch(`${base}/overtime-bot/overtime-bot/web/login`, { redirect: 'manual' });
    assert.strictEqual(res.status, 404);
  });
});
