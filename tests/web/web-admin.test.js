'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { createWebApp } = require('../../src/web/index');
const { createInMemoryAccountStore } = require('../../src/web/account-store');
const { validatePasswordStrength, askHidden } = require('../../scripts/web-bootstrap-admin');
const { LoginRateLimiter } = require('../../src/web/rate-limit');

/** Jalankan app Express pada port acak; helper fetch dengan cookie jar sederhana. */
async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const jar = new Map();
  const h = {
    base,
    jar,
    cookieHeader() {
      return [...jar.keys()].map((k) => `${k}=${jar.get(k)}`).join('; ');
    },
    storeCookies(res) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
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

function makeApp(nodeEnv) {
  const passwordHash = bcrypt.hashSync('correct-horse-42', 4);
  const store = createInMemoryAccountStore([{ id: 1, username: 'admin', passwordHash }]);
  return createWebApp({
    accountStore: store,
    sessionSecret: 'test-secret-0123456789abcdef0123456789abcdef',
    env: { NODE_ENV: nodeEnv || 'development' },
  });
}

async function getLoginCsrf(h) {
  const res = await h.get('/web/login');
  const html = await res.text();
  const m = /name="csrf-token" content="([0-9a-f]+)"/.exec(html);
  return m[1];
}

test('halaman login dapat diakses tanpa autentikasi; cookie & CSRF benar', async () => {
  await withServer(makeApp(), async (h) => {
    const res = await h.get('/web/login');
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /name="csrf-token" content="[0-9a-f]{64}"/);
    assert.ok(!html.includes('__CSRF_TOKEN__'));
    const sid = res.headers.getSetCookie().find((c) => c.startsWith('lunifar.sid='));
    assert.ok(sid, 'session cookie ada');
    assert.match(sid, /HttpOnly/i);
    assert.match(sid, /SameSite=Strict/i);
    assert.ok(!/Secure/i.test(sid), 'tanpa Secure di development');
  });
});

test('endpoint privat menolak request tanpa sesi', async () => {
  await withServer(makeApp(), async (h) => {
    const res = await h.get('/api/auth/me');
    assert.strictEqual(res.status, 401);
    const page = await h.get('/web/dashboard');
    assert.strictEqual(page.status, 302);
    assert.match(page.headers.get('location'), /\/web\/login/);
  });
});

test('login gagal: respons generik, tidak membocorkan keberadaan user', async () => {
  await withServer(makeApp(), async (h) => {
    const csrf = await getLoginCsrf(h);
    for (const cred of [{ username: 'admin', password: 'salah' }, { username: 'nosuchuser', password: 'salah' }]) {
      const res = await h.post('/api/auth/login', cred, { csrf });
      assert.strictEqual(res.status, 401);
      assert.strictEqual((await res.json()).error, 'Username atau password salah.');
    }
  });
});

test('login sukses: session ID berubah, CSRF di-rotate, dashboard terbuka', async () => {
  await withServer(makeApp(), async (h) => {
    const csrf = await getLoginCsrf(h);
    const sidBefore = h.jar.get('lunifar.sid');
    const res = await h.post('/api/auth/login', { username: 'admin', password: 'correct-horse-42' }, { csrf });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.ok(body.csrfToken && body.csrfToken !== csrf, 'CSRF token baru');
    assert.notStrictEqual(h.jar.get('lunifar.sid'), sidBefore, 'session ID diregenerasi');
    const me = await h.get('/api/auth/me');
    assert.strictEqual(me.status, 200);
    assert.strictEqual((await me.json()).user.username, 'admin');
    const dash = await h.get('/web/dashboard');
    assert.strictEqual(dash.status, 200);
    assert.match(await dash.text(), /Dashboard Admin/);
  });
});

test('logout mengakhiri sesi', async () => {
  await withServer(makeApp(), async (h) => {
    const csrf = await getLoginCsrf(h);
    const login = await h.post('/api/auth/login', { username: 'admin', password: 'correct-horse-42' }, { csrf });
    const newCsrf = (await login.json()).csrfToken;
    const out = await h.post('/api/auth/logout', undefined, { csrf: newCsrf });
    assert.strictEqual(out.status, 200);
    assert.strictEqual((await h.get('/api/auth/me')).status, 401);
  });
});

test('request state-changing tanpa/CSRF salah ditolak 403', async () => {
  await withServer(makeApp(), async (h) => {
    await h.get('/web/login');
    const noToken = await h.post('/api/auth/login', { username: 'admin', password: 'x' });
    assert.strictEqual(noToken.status, 403);
    const badToken = await h.post('/api/auth/login', { username: 'admin', password: 'x' }, { csrf: 'a'.repeat(64) });
    assert.strictEqual(badToken.status, 403);
  });
});

test('rate limiting login: percobaan berlebih menghasilkan 429', async () => {
  await withServer(makeApp(), async (h) => {
    const csrf = await getLoginCsrf(h);
    let last;
    for (let i = 0; i < 6; i += 1) {
      last = await h.post('/api/auth/login', { username: 'ratelimit', password: 'wrong' }, { csrf });
    }
    assert.strictEqual(last.status, 429);
    const body = await last.json();
    assert.ok(body.error && !/password/i.test(body.error));
  });
});

test('cookie Secure diset saat production (di belakang proxy HTTPS)', async () => {
  await withServer(makeApp('production'), async (h) => {
    const res = await h.get('/web/login', { headers: { 'X-Forwarded-Proto': 'https' } });
    const sid = res.headers.getSetCookie().find((c) => c.startsWith('lunifar.sid='));
    assert.ok(sid, 'cookie diterbitkan');
    assert.match(sid, /Secure/i);
    assert.match(sid, /HttpOnly/i);
    assert.match(sid, /SameSite=Strict/i);
  });
});

test('createWebApp tidak membuka port, tidak menjalankan bot, dan memvalidasi secret', () => {
  const app = makeApp();
  assert.strictEqual(typeof app, 'function');
  assert.ok(!app.listening);
  assert.throws(() => createWebApp({ accountStore: createInMemoryAccountStore(), env: {} }), /SESSION_SECRET/);
  assert.throws(
    () => createWebApp({ accountStore: createInMemoryAccountStore(), env: { SESSION_SECRET: 'pendek' } }),
    /SESSION_SECRET/,
  );
});

test('bootstrap: validasi kekuatan password', () => {
  assert.ok(validatePasswordStrength('short1a'));
  assert.ok(validatePasswordStrength('nonumbersonlyletters'));
  assert.ok(validatePasswordStrength('123456789012'));
  assert.strictEqual(validatePasswordStrength('Str0ngPassw0rd!'), null);
  assert.strictEqual(typeof askHidden, 'function');
});

test('rate limiter unit: window, reset, case-insensitive', () => {
  let nowMs = 1_000_000;
  const rl = new LoginRateLimiter({ maxAttempts: 3, windowMs: 60_000, now: () => nowMs });
  for (let i = 0; i < 3; i += 1) rl.recordFailure('1.2.3.4', 'u1');
  assert.strictEqual(rl.check('1.2.3.4', 'u1').allowed, false);
  nowMs += 61_000;
  assert.strictEqual(rl.check('1.2.3.4', 'u1').allowed, true);
  rl.recordFailure('1.2.3.4', 'u1');
  rl.reset('1.2.3.4', 'u1');
  assert.strictEqual(rl.check('1.2.3.4', 'U1').remaining, 3);
});

