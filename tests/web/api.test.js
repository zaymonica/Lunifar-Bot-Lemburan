'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { createWebApp } = require('../../src/web/index');
const { createInMemoryAccountStore } = require('../../src/web/account-store');

/** Sama polanya dengan web-admin.test.js: server port acak + cookie jar. */
async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
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
          ...(this.cookieHeader() ? { Cookie: this.cookieHeader() } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      this.storeCookies(res);
      return res;
    },
    get(path) { return this.req('GET', path); },
    post(path, body, headers) { return this.req('POST', path, body, headers); },
    del(path, headers) { return this.req('DELETE', path, undefined, headers); },
  };
  try {
    return await fn(h);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Deps palsu untuk API domain — semua metode tervalidasi lewat jalur asli. */
function makeApiDeps(overrides = {}) {
  const employees = [
    { id: 1, full_name: 'Budi', employee_number: 'EMP001', department: 'IT', role: 'admin', status: 'active', is_active: 1, language: 'id' },
    { id: 2, full_name: 'Sari', employee_number: 'EMP002', department: 'HR', role: 'employee', status: 'pending', is_active: 0, language: 'en' },
  ];
  const sessions = [
    { id: 10, employee_id: 2, status: 'pending', start_at: '2026-10-01T12:00:00Z', end_at: '2026-10-01T15:00:00Z' },
  ];
  const auditRows = [];
  return {
    config: { timezone: 'Asia/Jakarta', adminTelegramIds: [111], botToken: '', overtime: {} },
    employeeRepo: {
      async countByStatus() { return [{ status: 'active', cnt: 1 }, { status: 'pending', cnt: 1 }]; },
      async list({ status }) { return status ? employees.filter((e) => e.status === status) : employees; },
      async findById(id) { return employees.find((e) => e.id === Number(id)) || null; },
      async setStatus(id, status, isActive) {
        const e = employees.find((x) => x.id === Number(id));
        if (e) { e.status = status; e.is_active = isActive ? 1 : 0; return true; }
        return false;
      },
      async setRole(id, role) { const e = employees.find((x) => x.id === Number(id)); if (e) e.role = role; return !!e; },
      async setLanguage(id, language) { const e = employees.find((x) => x.id === Number(id)); if (e) e.language = language; return !!e; },
    },
    overtimeRepo: {
      async countByStatus() { return [{ status: 'pending', cnt: 1 }]; },
      async search(q) {
        let rows = sessions;
        if (q.status) rows = rows.filter((r) => r.status === q.status);
        return rows;
      },
      async findById(id) { return sessions.find((r) => r.id === Number(id)) || null; },
    },
    approvalService: {
      async listPending() { return sessions.filter((s) => s.status === 'pending'); },
      async decide({ sessionId, approve }) {
        const s = sessions.find((r) => r.id === Number(sessionId));
        if (!s) { const e = new Error('not found'); e.name = 'NotFoundError'; throw e; }
        s.status = approve ? 'approved' : 'rejected';
        return { status: s.status, actualMinutes: 180, payableMinutes: 180 };
      },
    },
    reportService: {
      async buildFilters(f) { return { ...f }; },
      async recap() { return [{ employeeNumber: 'EMP001', minutes: 120 }]; },
      async exportExcel() { return 'unused-path'; },
    },
    settingsStore: {
      tokenEnabled: true,
      async getBotTokenStatus() { return { enabled: true, configured: true, masked: '****ABCD' }; },
      async setBotToken(token) { overrides.savedToken = token; return true; },
      async clearBotToken() { overrides.cleared = true; return true; },
    },
    adminAudit: {
      repo: { async list(q) { return auditRows.slice(0, q.limit); } },
      logger: async (req, action) => { auditRows.push({ action }); },
    },
    botLifecycle: {
      get status() { return { state: 'stopped', error: null, startedAt: null }; },
      async start() { return { state: 'running' }; },
      async stop() { return { state: 'stopped' }; },
      async restart() { return { state: 'running' }; },
    },
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

async function login(h) {
  const page = await h.get('/web/login');
  const html = await page.text();
  const csrf = /name="csrf-token" content="([0-9a-f]+)"/.exec(html)[1];
  const res = await h.post('/api/auth/login', { username: 'admin', password: 'correct-horse-42' }, { 'X-CSRF-Token': csrf });
  assert.strictEqual(res.status, 200);
  const me = await h.get('/api/auth/me');
  const { csrfToken } = await me.json();
  return csrfToken;
}

test('API domain: tanpa sesi semua endpoint domain ditolak 401', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    for (const p of ['/api/dashboard', '/api/employees', '/api/overtime', '/api/settings', '/api/bot', '/api/audit']) {
      const res = await h.get(p);
      assert.strictEqual(res.status, 401, p);
    }
  });
});

test('dashboard + employees: butuh sesi, response {ok,data}, validasi enum', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    await login(h);
    const dash = await h.get('/api/dashboard');
    assert.strictEqual(dash.status, 200);
    const d = (await dash.json()).data;
    assert.strictEqual(d.employees.total, 2);
    assert.strictEqual(d.pendingApprovals, 1);

    const bad = await h.get('/api/employees?status=hacker');
    assert.strictEqual(bad.status, 400);

    const ok = await h.get('/api/employees?status=pending');
    if (ok.status !== 200) console.error('DEBUG employees', ok.status, await ok.text());
    const list = (await ok.json()).data;
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].fullName, 'Sari');
  });
});

test('mutasi pegawai butuh CSRF; setStatus/setRole/setLanguage bekerja', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    await login(h);
    const noCsrf = await h.post('/api/employees/2/status', { status: 'active' });
    assert.strictEqual(noCsrf.status, 403);

    const csrf = (await (await h.get('/api/auth/me')).json()).csrfToken;
    const hdr = { 'X-CSRF-Token': csrf };
    const ok = await h.post('/api/employees/2/status', { status: 'active' }, hdr);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await ok.json()).data.status, 'active');

    const badEnum = await h.post('/api/employees/2/role', { role: 'superadmin' }, hdr);
    assert.strictEqual(badEnum.status, 400);

    const lang = await h.post('/api/employees/2/language', { language: 'zh-TW' }, hdr);
    assert.strictEqual(lang.status, 200);

    const nf = await h.post('/api/employees/99/status', { status: 'active' }, hdr);
    assert.strictEqual(nf.status, 404);
  });
});

test('approvals: decide sukses; tanpa WEB_APPROVER_EMPLOYEE_ID → 409', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    const csrf = await login(h);
    const hdr = { 'X-CSRF-Token': csrf };
    delete process.env.WEB_APPROVER_EMPLOYEE_ID;
    const blocked = await h.post('/api/approvals/10/decide', { approve: true }, hdr);
    assert.strictEqual(blocked.status, 409);

    process.env.WEB_APPROVER_EMPLOYEE_ID = '1';
    try {
      const ok = await h.post('/api/approvals/10/decide', { approve: true, note: 'setuju' }, hdr);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual((await ok.json()).data.status, 'approved');
    } finally {
      delete process.env.WEB_APPROVER_EMPLOYEE_ID;
    }
  });
});

test('payroll & recap: validasi bulan/tahun; agregat dari repo palsu', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    await login(h);
    const bad = await h.get('/api/reports/payroll?month=13&year=2026');
    assert.strictEqual(bad.status, 400);
    const ok = await h.get('/api/reports/payroll?month=10&year=2026');
    assert.strictEqual(ok.status, 200);
    const data = (await ok.json()).data;
    assert.strictEqual(data.year, 2026);
    assert.ok(Array.isArray(data.days));
    const recap = await h.get('/api/reports/recap?from=2026-10-01&to=2026-10-31');
    assert.strictEqual(recap.status, 200);
  });
});

test('settings & bot: token tak pernah keluar; lifecycle bekerja', async () => {
  const state = {};
  const deps = makeApiDeps(state);
  await withServer(makeApp(deps), async (h) => {
    const csrf = await login(h);
    const hdr = { 'X-CSRF-Token': csrf };

    const st = await h.get('/api/settings');
    const mask = (await st.json()).data.botToken.masked;
    assert.match(mask, /^\*+ABCD$/);

    const badTok = await h.post('/api/settings/bot-token', { token: 'short' }, hdr);
    assert.strictEqual(badTok.status, 400);
    const goodTok = await h.post('/api/settings/bot-token', { token: '123456:ABC-DEF_abcdefghijklmnopqrstuvwxyz123' }, hdr);
    if (goodTok.status !== 200) console.error('DEBUG token', goodTok.status, await goodTok.text());
    assert.strictEqual(goodTok.status, 200);
    assert.ok(state.savedToken && state.savedToken.startsWith('123456:'));

    const clear = await h.del('/api/settings/bot-token', hdr);
    assert.strictEqual(clear.status, 200);
    assert.ok(state.cleared);

    const bot = await h.get('/api/bot');
    assert.strictEqual((await bot.json()).data.state, 'stopped');
    const start = await h.post('/api/bot/start', {}, hdr);
    assert.strictEqual((await start.json()).data.state, 'running');
  });
});

test('audit endpoint: limit dibatasi', async () => {
  await withServer(makeApp(makeApiDeps()), async (h) => {
    await login(h);
    const res = await h.get('/api/audit?limit=5');
    assert.strictEqual(res.status, 200);
    const list = await h.get('/api/audit?limit=999');
    assert.strictEqual(list.status, 400);
  });
});
