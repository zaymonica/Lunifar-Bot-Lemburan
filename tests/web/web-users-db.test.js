'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { createWebApp } = require('../../src/web/index');
const { WebUserRepository, createDbAccountStore } = require('../../src/web/web-user.repo');
const { createAdminUser } = require('../../scripts/web-bootstrap-admin');
const { assertWebWriteTarget, DEV_ALLOWED_MIGRATION_DBS } = require('../../src/config/env');

/* ---------- Pool mock: cukup implement execute() ---------- */
function makeMockPool(rowsByCall, { throwOnCreate = null } = {}) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      if (/INSERT INTO web_users/.test(sql)) {
        if (throwOnCreate) throw throwOnCreate;
        return [{ insertId: 42, affectedRows: 1 }];
      }
      if (/UPDATE web_users/.test(sql)) return [{ affectedRows: params[1] === 1 ? 1 : 1 }];
      if (/SELECT COUNT/.test(sql)) return [[{ cnt: rowsByCall.length }]];
      return [rowsByCall];
    },
  };
}

const HASH_OK = bcrypt.hashSync('correct-horse-42', 4);
const ACTIVE_ROW = { id: 1, username: 'admin', passwordHash: HASH_OK, isActive: 1 };
const INACTIVE_ROW = { id: 2, username: 'nonaktif', passwordHash: HASH_OK, isActive: 0 };

/* ---------- Repository ---------- */
test('repo: findByUsername menemukan akun aktif via prepared statement', async () => {
  const pool = makeMockPool([ACTIVE_ROW]);
  const repo = new WebUserRepository(pool);
  const user = await repo.findByUsername('admin');
  assert.strictEqual(user.id, 1);
  assert.strictEqual(user.isActive, true);
  assert.match(pool.calls[0].sql, /WHERE username = \?/);
  assert.deepStrictEqual(pool.calls[0].params, ['admin']);
});

test('repo: findByUsername null saat tidak ditemukan; isActive false utk nonaktif', async () => {
  assert.strictEqual(await new WebUserRepository(makeMockPool([])).findByUsername('ghost'), null);
  const user = await new WebUserRepository(makeMockPool([INACTIVE_ROW])).findByUsername('nonaktif');
  assert.strictEqual(user.isActive, false);
});

test('repo: create memakai parameter binding (hash, bukan plaintext)', async () => {
  const pool = makeMockPool([]);
  const repo = new WebUserRepository(pool);
  const id = await repo.create({ username: 'admin', passwordHash: HASH_OK });
  assert.strictEqual(id, 42);
  assert.match(pool.calls[0].sql, /VALUES \(\?, \?, 1\)/);
  assert.match(pool.calls[0].params[1], /^\$2[aby]\$/);
  assert.ok(!pool.calls[0].params.includes('correct-horse-42'));
});

test('repo: ER_DUP_ENTRY dari DB diteruskan (race duplikat)', async () => {
  const dupErr = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  const repo = new WebUserRepository(makeMockPool([], { throwOnCreate: dupErr }));
  await assert.rejects(() => repo.create({ username: 'admin', passwordHash: HASH_OK }), (e) => e.code === 'ER_DUP_ENTRY');
});

test('repo: setActive menulis 1/0; count membaca jumlah', async () => {
  const pool = makeMockPool([]);
  const repo = new WebUserRepository(pool);
  assert.strictEqual(await repo.setActive(1, false), true);
  assert.deepStrictEqual(pool.calls[0].params, [0, 1]);
  assert.strictEqual(await repo.count(), 0);
});

/* ---------- Adapter accountStore ---------- */
test('adapter: normalisasi lowercase+trim, tolak non-string/kosong', async () => {
  const pool = makeMockPool([ACTIVE_ROW]);
  const store = createDbAccountStore(new WebUserRepository(pool));
  const u = await store.findByUsername('  ADMIN ');
  assert.strictEqual(u.username, 'admin');
  assert.deepStrictEqual(pool.calls[0].params, ['admin']);
  assert.strictEqual(await store.findByUsername(123), null);
  assert.strictEqual(await store.findByUsername('   '), null);
});

/* ---------- createAdminUser (bootstrap terintegrasi) ---------- */
test('bootstrap createAdminUser: sukses, ternormalisasi lowercase, tanpa plaintext ke repo', async () => {
  const pool = makeMockPool([]);
  const repo = new WebUserRepository(pool);
  const res = await createAdminUser(repo, '  Admin ', 'RahasiaKuat123');
  assert.strictEqual(res.username, 'admin');
  const insert = pool.calls.find((c) => /INSERT INTO web_users/.test(c.sql));
  assert.match(insert.params[1], /^\$2[aby]\$/);
  assert.ok(!JSON.stringify(pool.calls).includes('RahasiaKuat123'));
});

test('bootstrap createAdminUser: menolak duplikat, password lemah, username invalid, repo kosong', async () => {
  const repo = new WebUserRepository(makeMockPool([ACTIVE_ROW]));
  await assert.rejects(() => createAdminUser(repo, 'admin', 'RahasiaKuat123'), (e) => e.code === 'ER_DUP_ENTRY');
  const empty = new WebUserRepository(makeMockPool([]));
  await assert.rejects(() => createAdminUser(empty, 'admin', 'pendek123'), (e) => e.code === 'PASSWORD_WEAK');
  await assert.rejects(() => createAdminUser(empty, 'x!', 'RahasiaKuat123'), (e) => e.code === 'USERNAME_INVALID');
  await assert.rejects(() => createAdminUser(null, 'admin', 'RahasiaKuat123'));
});

/* ---------- Guard target penulisan web ---------- */
test('guard: development hanya DB testing terdaftar; produksi butuh konfirmasi eksplisit', () => {
  for (const db of DEV_ALLOWED_MIGRATION_DBS) {
    assert.strictEqual(assertWebWriteTarget(db, 'development'), true);
  }
  assert.throws(() => assertWebWriteTarget('lunifar_overtime', 'development'), (e) => e.code === 'WEB_TARGET');
  assert.throws(() => assertWebWriteTarget('lunifar_overtime', 'production'), (e) => e.code === 'WEB_TARGET');
/* ---------- Integrasi HTTP: login via DB store ---------- */
async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const jar = new Map();
  const h = {
    base,
    cookieHeader() { return [...jar.keys()].map((k) => `${k}=${jar.get(k)}`).join('; '); },
    storeCookies(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
    sid() { return jar.get('lunifar.sid'); },
    async get(path, opts = {}) {
      const res = await fetch(base + path, {
        headers: { ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}), ...(opts.headers || {}) },
        redirect: 'manual',
      });
      this.storeCookies(res);
      return res;
    },
    async post(path, body, { headers = {}, csrf = null } = {}) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
          ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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

function makeDbApp(rows) {
  const store = createDbAccountStore(new WebUserRepository(makeMockPool(rows)));
  return createWebApp({
    accountStore: store,
    sessionSecret: 'test-secret-0123456789abcdef0123456789abcdef',
    env: { NODE_ENV: 'development' },
  });
}

async function getLoginCsrf(h) {
  const res = await h.get('/web/login');
  const m = /name="csrf-token" content="([0-9a-f]+)"/.exec(await res.text());
  return m[1];
}

test('HTTP: login sukses dengan akun dari DB store; session ID berubah; hash tidak pernah dikirim', async () => {
  await withServer(makeDbApp([ACTIVE_ROW]), async (h) => {
    await h.get('/web/login');
    const sidBefore = h.sid();
    const csrf = await getLoginCsrf(h);
    const res = await h.post('/api/auth/login', { username: 'admin', password: 'correct-horse-42' }, { csrf });
    assert.strictEqual(res.status, 200);
    assert.notStrictEqual(h.sid(), sidBefore);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes('$2'));
    const me = await h.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    const meBody = await me.json();
    assert.strictEqual(meBody.user.username, 'admin');
    assert.ok(!JSON.stringify(meBody).includes('$2'));
    assert.ok(!JSON.stringify(meBody).includes('passwordHash'));
  });
});

test('HTTP: akun nonaktif ditolak dengan respons generik 401', async () => {
  await withServer(makeDbApp([INACTIVE_ROW]), async (h) => {
    const csrf = await getLoginCsrf(h);
    const res = await h.post('/api/auth/login', { username: 'nonaktif', password: 'correct-horse-42' }, { csrf });
    assert.strictEqual(res.status, 401);
    assert.strictEqual((await res.json()).error, 'Username atau password salah.');
  });
});

test('HTTP: password salah generik; CSRF wajib; logout mengakhiri sesi', async () => {
  await withServer(makeDbApp([ACTIVE_ROW]), async (h) => {
    let csrf = await getLoginCsrf(h);
    const bad = await h.post('/api/auth/login', { username: 'admin', password: 'wrong-pass-999' }, { csrf });
    assert.strictEqual(bad.status, 401);
    assert.strictEqual((await bad.json()).error, 'Username atau password salah.');

    csrf = await getLoginCsrf(h);
    const ok = await h.post('/api/auth/login', { username: 'admin', password: 'correct-horse-42' }, { csrf });
    assert.strictEqual(ok.status, 200);

    const noCsrf = await h.post('/api/auth/logout', {});
    assert.strictEqual(noCsrf.status, 403);

    const me = await h.get('/api/auth/me');
    const meCsrf = (await me.json()).csrfToken;
    const out = await h.post('/api/auth/logout', {}, { csrf: meCsrf });
    assert.ok([200, 302].includes(out.status));
    assert.strictEqual((await h.get('/api/auth/me')).status, 401);
  });
});

test('HTTP: username tidak dikenal di DB → respons generik 401', async () => {
  await withServer(makeDbApp([]), async (h) => {
    const csrf = await getLoginCsrf(h);
    const res = await h.post('/api/auth/login', { username: 'ghost', password: 'correct-horse-42' }, { csrf });
    assert.strictEqual(res.status, 401);
  });
});

  assert.strictEqual(assertWebWriteTarget('lunifar_overtime', 'production', 'YES'), true);
  assert.throws(() => assertWebWriteTarget('lunifar_overtime', 'production', 'yes'), (e) => e.code === 'WEB_TARGET');
});
