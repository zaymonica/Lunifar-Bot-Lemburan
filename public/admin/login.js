'use strict';
// Frontend login. Tidak menggunakan innerHTML dengan input pengguna (anti-XSS);
// semua teks dinamis disetel lewat textContent.
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.content : '';
  var form = document.getElementById('login-form');
  var msg = document.getElementById('msg');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    msg.textContent = '';
    var username = document.getElementById('username').value;
    var password = document.getElementById('password').value;
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({ username: username, password: password }),
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.status === 200 && res.body.ok) {
          window.location.href = '/web/dashboard';
        } else {
          msg.textContent = res.body && res.body.error ? res.body.error : 'Login gagal.';
        }
      })
      .catch(function () { msg.textContent = 'Gagal terhubung ke server.'; });
  });
})();
