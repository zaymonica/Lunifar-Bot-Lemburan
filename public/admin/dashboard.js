'use strict';
// Frontend Web Admin (Tahap 3). SPA tanpa framework; semua output lewat
// textContent/createElement — tidak ada innerHTML dengan data server (anti-XSS).
(function () {
  var csrfToken = '';
  var auditOffset = 0;

  // Fallback awal: token dari meta halaman (dirender server dengan token sesi).
  var metaEl = document.querySelector('meta[name="csrf-token"]');
  if (metaEl && metaEl.content) csrfToken = metaEl.content;

  // Ambil ulang CSRF token dari sesi saat ini (dipakai untuk pemulihan 403).
  function refreshCsrf() {
    return fetch('/api/auth/me', { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 401) { window.location.href = '/web/login'; throw new Error('sesi berakhir'); }
        return r.json();
      })
      .then(function (j) {
        if (j && j.ok && j.csrfToken) { csrfToken = j.csrfToken; return true; }
        return false;
      });
  }

  function $(id) { return document.getElementById(id); }
  function flash(msg, isErr) {
    var el = $('flash');
    el.textContent = msg || '';
    el.className = 'msg' + (isErr ? ' err' : '');
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function cell(tr, text) {
    var td = document.createElement('td');
    td.textContent = text == null ? '-' : String(text);
    tr.appendChild(td);
    return td;
  }
  function table(headers) {
    var t = document.createElement('table');
    var thead = document.createElement('thead');
    var trh = document.createElement('tr');
    headers.forEach(function (hx) {
      var th = document.createElement('th');
      th.textContent = hx;
      trh.appendChild(th);
    });
    thead.appendChild(trh); t.appendChild(thead);
    var tb = document.createElement('tbody');
    t.appendChild(tb);
    return { t: t, tb: tb };
  }
  function actionBtn(label, onOk, className) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (className) b.className = className;
    b.addEventListener('click', function () { onOk(b); });
    return b;
  }

  function api(method, path, body, isRetry) {
    return fetch(path, {
      method: method,
      headers: Object.assign(
        { 'X-Requested-With': 'fetch' },
        body !== undefined ? { 'Content-Type': 'application/json' } : {},
        csrfToken ? { 'X-CSRF-Token': csrfToken } : {}
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      if (r.status === 401) { window.location.href = '/web/login'; throw new Error('sesi berakhir'); }
      return r.json().then(function (j) {
        if (!j.ok) {
          // Pemulihan otomatis untuk 403 CSRF (token stale di halaman lama):
          // ambil token terbaru dari sesi dan coba SEKALI lagi. CSRF tetap
          // divalidasi penuh oleh server — tidak ada pengecualian.
          if (r.status === 403 && !isRetry && j.error && /CSRF/i.test(j.error)) {
            return refreshCsrf().then(function (fresh) {
              if (fresh) return api(method, path, body, true);
              throw new Error(j.error);
            });
          }
          throw new Error(j.error || ('HTTP ' + r.status));
        }
        return j.data;
      });
    });
  }
  function apiGet(path) { return api('GET', path); }
  function apiPost(path, body) { return api('POST', path, body === undefined ? {} : body); }

  function fmtMin(m) {
    var n = Number(m) || 0;
    return Math.floor(n / 60) + 'j ' + (n % 60) + 'm';
  }
  function fmtDate(s) {
    if (!s) return '-';
    return String(s).replace('T', ' ').replace('Z', ' UTC').slice(0, 19);
  }

  function statCard(label, value) {
    var c = document.createElement('div');
    c.className = 'stat';
    var v = document.createElement('strong'); v.textContent = value;
    var l = document.createElement('span'); l.textContent = label;
    c.appendChild(v); c.appendChild(l);
    return c;
  }

  // ---- Ringkasan ----
  function loadDashboard() {
    apiGet('/api/dashboard').then(function (d) {
      var cards = $('dash-cards');
      clear(cards);
      cards.appendChild(statCard('Pegawai aktif', d.employees.active));
      cards.appendChild(statCard('Pendaftar pending', d.employees.pending));
      cards.appendChild(statCard('Lembur pending', d.overtime.pending || 0));
      cards.appendChild(statCard('Lembur disetujui', d.overtime.approved || 0));
      cards.appendChild(statCard('Bot', d.bot && d.bot.state ? d.bot.state : '-'));
      var pend = $('dash-pending');
      clear(pend);
      apiGet('/api/approvals/pending').then(function (rows) {
        if (!rows.length) { pend.textContent = 'Tidak ada persetujuan tertunda.'; return; }
        var t = table(['ID', 'Karyawan', 'Mulai', 'Selesai', 'Status']);
        rows.forEach(function (r) {
          var tr = document.createElement('tr');
          cell(tr, r.id);
          cell(tr, r.employee_name || r.employee_id);
          cell(tr, fmtDate(r.start_at));
          cell(tr, fmtDate(r.end_at));
          cell(tr, r.status);
          t.tb.appendChild(tr);
        });
        pend.appendChild(t.t);
      }).catch(function (e) { pend.textContent = e.message; });
    }).catch(function (e) { flash(e.message, true); });
  }

  // ---- Pegawai ----
  function loadEmployees(search, status) {
    var q = new URLSearchParams();
    if (search) q.set('search', search);
    if (status) q.set('status', status);
    apiGet('/api/employees?' + q.toString()).then(function (rows) {
      var box = $('emp-list');
      clear(box);
      if (!rows.length) { box.textContent = 'Tidak ada data.'; return; }
      var t = table(['ID', 'Nama', 'NIP', 'Departemen', 'Role', 'Status', 'Bahasa', 'Aksi']);
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        cell(tr, r.id); cell(tr, r.fullName); cell(tr, r.employeeNumber);
        cell(tr, r.department); cell(tr, r.role); cell(tr, r.status); cell(tr, r.language);
        var tdA = document.createElement('td');
        if (r.status !== 'active') {
          tdA.appendChild(actionBtn('Aktifkan', function (b) {
            b.disabled = true;
            apiPost('/api/employees/' + r.id + '/status', { status: 'active' })
              .then(function () { flash('Pegawai diaktifkan.'); loadEmployees(search, status); })
              .catch(function (e) { b.disabled = false; flash(e.message, true); });
          }, 'ok'));
        } else {
          tdA.appendChild(actionBtn('Nonaktifkan', function (b) {
            b.disabled = true;
            apiPost('/api/employees/' + r.id + '/status', { status: 'inactive' })
              .then(function () { flash('Pegawai dinonaktifkan.'); loadEmployees(search, status); })
              .catch(function (e) { b.disabled = false; flash(e.message, true); });
          }, 'warn'));
        }
        ['supervisor', 'admin'].forEach(function (role) {
          if (r.role !== role) {
            tdA.appendChild(actionBtn('→' + role, function (b) {
              b.disabled = true;
              apiPost('/api/employees/' + r.id + '/role', { role: role })
                .then(function () { flash('Role diubah.'); loadEmployees(search, status); })
                .catch(function (e) { b.disabled = false; flash(e.message, true); });
            }, 'mini'));
          }
        });
        tr.appendChild(tdA);
        t.tb.appendChild(tr);
      });
      box.appendChild(t.t);
    }).catch(function (e) { flash(e.message, true); });
  }

  // ---- Lembur ----
  function decideRow(sessionId, approve, after) {
    var note = approve ? null : (window.prompt('Catatan penolakan (opsional):') || '');
    apiPost('/api/approvals/' + sessionId + '/decide', { approve: !!approve, note: note })
      .then(function (d) {
        flash('Sesi #' + d.sessionId + ' → ' + d.status + ' (' + fmtMin(d.payableMinutes) + ')');
        after();
      })
      .catch(function (e) { flash(e.message, true); after(); });
  }

  function loadOvertime() {
    apiGet('/api/approvals/pending').then(function (rows) {
      var box = $('ot-pending');
      clear(box);
      if (!rows.length) { box.textContent = 'Tidak ada antrean.'; return; }
      var t = table(['ID', 'Karyawan', 'Mulai', 'Selesai', 'Aksi']);
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        cell(tr, r.id); cell(tr, r.employee_name || r.employee_id);
        cell(tr, fmtDate(r.start_at)); cell(tr, fmtDate(r.end_at));
        var tdA = document.createElement('td');
        tdA.appendChild(actionBtn('Setujui', function () { decideRow(r.id, true, loadOvertime); }, 'ok'));
        tdA.appendChild(actionBtn('Tolak', function () { decideRow(r.id, false, loadOvertime); }, 'warn'));
        tr.appendChild(tdA);
        t.tb.appendChild(tr);
      });
      box.appendChild(t.t);
    }).catch(function (e) { $('ot-pending').textContent = e.message; });

    var q = new URLSearchParams();
    var from = $('ot-from').value; var to = $('ot-to').value; var st = $('ot-status').value;
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (st) q.set('status', st);
    apiGet('/api/overtime?' + q.toString()).then(function (rows) {
      var box = $('ot-list');
      clear(box);
      if (!rows.length) { box.textContent = 'Tidak ada data.'; return; }
      var t = table(['ID', 'Karyawan', 'Mulai', 'Selesai', 'Status', 'Aktual', 'Dibayar', 'Catatan']);
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        cell(tr, r.id); cell(tr, r.employee_name || r.employee_id);
        cell(tr, fmtDate(r.start_at)); cell(tr, fmtDate(r.end_at)); cell(tr, r.status);
        cell(tr, fmtMin(r.actual_minutes)); cell(tr, fmtMin(r.payable_minutes));
        cell(tr, r.decision_note);
        t.tb.appendChild(tr);
      });
      box.appendChild(t.t);
    }).catch(function (e) { flash(e.message, true); });
  }

  // ---- Laporan ----
  function loadRecap() {
    var q = new URLSearchParams({ from: $('rep-from').value, to: $('rep-to').value });
    apiGet('/api/reports/recap?' + q.toString()).then(function (rows) {
      var box = $('rep-out');
      clear(box);
      if (!rows.length) { box.textContent = 'Tidak ada data pada rentang ini.'; return; }
      var t = table(['NIP', 'Nama', 'Departemen', 'Sesi', 'Menit', 'Estimasi biaya']);
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        cell(tr, r.employeeNumber); cell(tr, r.fullName); cell(tr, r.department);
        cell(tr, r.sessions); cell(tr, fmtMin(r.totalMinutes)); cell(tr, r.totalCents != null ? (r.totalCents / 100).toFixed(2) : '-');
        t.tb.appendChild(tr);
      });
      box.appendChild(t.t);
    }).catch(function (e) { flash(e.message, true); });
  }

  function loadPayroll() {
    var q = new URLSearchParams({ month: $('pay-month').value, year: $('pay-year').value });
    apiGet('/api/reports/payroll?' + q.toString()).then(function (d) {
      var box = $('pay-out');
      clear(box);
      var cards = document.createElement('div');
      cards.className = 'cards';
      cards.appendChild(statCard('Sesi harian', d.totals.dayCount));
      cards.appendChild(statCard('Total menit', fmtMin(d.totals.minutes)));
      cards.appendChild(statCard('Total biaya', (d.totals.totalCents / 100).toFixed(2)));
      box.appendChild(cards);
    }).catch(function (e) { flash(e.message, true); });
  }

  function download(path) {
    fetch(path, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { window.location.href = '/web/login'; return null; }
      if (!r.ok) { r.json().then(function (j) { flash(j.error || 'Gagal mengunduh.', true); }); return null; }
      var cd = r.headers.get('Content-Disposition') || '';
      var m = /filename="([^"]+)"/.exec(cd);
      return r.blob().then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = m ? m[1] : 'export.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(a.href);
        flash('Unduhan dimulai.');
      });
    }).catch(function () { flash('Gagal mengunduh.', true); });
  }

  // ---- Bot & pengaturan ----
  function loadBot() {
    apiGet('/api/bot').then(function (d) {
      var cards = $('bot-status');
      clear(cards);
      cards.appendChild(statCard('Status', d.state));
      cards.appendChild(statCard('Token terkonfigurasi', d.tokenConfigured ? 'ya' : 'tidak'));
      if (d.startedAt) cards.appendChild(statCard('Sejak', fmtDate(d.startedAt)));
      if (d.error) cards.appendChild(statCard('Kesalahan terakhir', d.error));
    }).catch(function (e) { flash(e.message, true); });
    apiGet('/api/settings').then(function (d) {
      $('token-info').textContent = d.botToken.enabled
        ? (d.botToken.configured ? 'Token tersimpan: ' + d.botToken.masked : 'Token belum disimpan.')
        : 'Penyimpanan token via web nonaktif (WEB_SETTINGS_KEY belum di-set).';
    }).catch(function () {});
  }

  function botAction(action) {
    apiPost('/api/bot/' + action).then(function (d) {
      flash('Bot: ' + d.state);
      loadBot();
    }).catch(function (e) { flash(e.message, true); });
  }

  function saveToken(test) {
    var token = $('token-input').value.trim();
    if (!token) { flash('Isi token terlebih dahulu.', true); return; }
    apiPost('/api/settings/bot-token', { token: token, test: !!test }).then(function (d) {
      $('token-input').value = '';
      flash(d.botUsername ? ('Tersimpan & teruji: @' + d.botUsername) : (d.testError ? d.testError : 'Token tersimpan.'));
      loadBot();
    }).catch(function (e) { flash(e.message, true); });
  }

  // ---- Audit ----
  function loadAudit(reset) {
    if (reset) auditOffset = 0;
    apiGet('/api/audit?limit=25&offset=' + auditOffset).then(function (rows) {
      var box = $('audit-list');
      if (reset) clear(box);
      if (!rows.length && reset) { box.textContent = 'Belum ada aktivitas.'; return; }
      var t = table(['Waktu', 'Aktor', 'Aksi', 'Objek', 'Detail']);
      rows.forEach(function (r) {
        var tr = document.createElement('tr');
        cell(tr, fmtDate(r.created_at)); cell(tr, r.username); cell(tr, r.action);
        cell(tr, r.entity_type ? r.entity_type + (r.entity_id ? ':' + r.entity_id : '') : '-');
        cell(tr, r.detail);
        t.tb.appendChild(tr);
      });
      if (rows.length) {
        box.appendChild(t.t);
        auditOffset += rows.length;
      }
    }).catch(function (e) { flash(e.message, true); });
  }

  // ---- Init & tab routing ----
  var TAB_NAMES = ['dashboard', 'employees', 'overtime', 'reports', 'bot', 'audit'];
  var TABS = {
    dashboard: loadDashboard,
    employees: function () { loadEmployees('', ''); },
    overtime: loadOvertime,
    reports: function () {},
    bot: loadBot,
    audit: function () { loadAudit(true); },
  };

  function showTab(name) {
    TAB_NAMES.forEach(function (n) {
      $('tab-' + n).className = 'tab' + (n === name ? ' active' : '');
    });
    var btns = $('tabs').querySelectorAll('button[data-tab]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = btns[i].getAttribute('data-tab') === name ? 'active' : '';
    }
    if (TABS[name]) TABS[name]();
  }

  $('tabs').addEventListener('click', function (ev) {
    var t = ev.target.getAttribute && ev.target.getAttribute('data-tab');
    if (t) showTab(t);
  });
  $('emp-filter').addEventListener('submit', function (ev) {
    ev.preventDefault();
    loadEmployees($('emp-search').value.trim(), $('emp-status').value);
  });
  $('ot-filter').addEventListener('submit', function (ev) { ev.preventDefault(); loadOvertime(); });
  $('rep-form').addEventListener('submit', function (ev) { ev.preventDefault(); loadRecap(); });
  $('rep-export').addEventListener('click', function () {
    download('/api/reports/export?from=' + $('rep-from').value + '&to=' + $('rep-to').value);
  });
  $('pay-form').addEventListener('submit', function (ev) { ev.preventDefault(); loadPayroll(); });
  $('pay-export').addEventListener('click', function () {
    download('/api/reports/payroll-export?month=' + $('pay-month').value + '&year=' + $('pay-year').value);
  });
  $('bot-start').addEventListener('click', function () { botAction('start'); });
  $('bot-stop').addEventListener('click', function () { botAction('stop'); });
  $('bot-restart').addEventListener('click', function () { botAction('restart'); });
  $('token-form').addEventListener('submit', function (ev) { ev.preventDefault(); saveToken(false); });
  $('token-test').addEventListener('click', function () { saveToken(true); });
  $('token-clear').addEventListener('click', function () {
    api('DELETE', '/api/settings/bot-token').then(function () {
      flash('Token dihapus.');
      loadBot();
    }).catch(function (e) { flash(e.message, true); });
  });
  $('audit-more').addEventListener('click', function () { loadAudit(false); });
  $('logout-btn').addEventListener('click', function () {
    apiPost('/api/auth/logout').finally(function () { window.location.href = '/web/login'; });
  });

  fetch('/api/auth/me', { headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
    .then(function (r) {
      if (r.status === 401) { window.location.href = '/web/login'; return null; }
      return r.json();
    })
    .then(function (j) {
      if (!j || !j.ok) return;
      csrfToken = j.csrfToken || '';
      $('whoami').textContent = j.user && j.user.username ? j.user.username : 'admin';
      showTab('dashboard');
    })
    .catch(function () {});
})();
