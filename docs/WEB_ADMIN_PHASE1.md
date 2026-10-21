# Web Admin — Tahap 1 (Fondasi)

Status: fondasi Express + autentikasi + sesi + CSRF + rate limit **selesai dan teruji** (11 test baru; regresi 175 test bot tetap lulus).

## Yang sudah ada
- `src/web/index.js` — `createWebApp()` factory. **Tidak** membuka port dan **tidak** menyentuh lifecycle bot. Mendukung embedding/test via `sessionSecret` eksplisit.
- `src/web/config.js` — validasi konfigurasi: `SESSION_SECRET` (≥32 karakter) wajib; `WEB_SESSION_TTL_HOURS`; `TRUST_PROXY` (otomatis aktif di production untuk Passenger/cPanel).
- `src/web/middleware/` — `auth.js` (requireApiAuth/requirePageAuth), `csrf.js` (synchronizer token per sesi, rotasi setelah login).
- `src/web/rate-limit.js` — limiter login in-memory (5 percobaan / 15 menit per IP+username).
- `src/web/routes/auth.js` — login/logout/me, halaman login & dashboard, render dengan injeksi CSRF token. Respons gagal generik; tidak ada logging kredensial/cookie/sesi.
- `src/web/account-store.js` — interface penyimpanan akun; implementasi in-memory **hanya untuk test**.
- `public/admin/` — login.html, dashboard.html (placeholder), admin.css, login.js, dashboard.js. Tanpa inline script (kompatibel CSP ketat), output lewat `textContent` (anti-XSS).
- `scripts/web-bootstrap-admin.js` — CLI interaktif: username + password (tanpa echo, tidak lewat argv) → bcrypt hash (cost 12) + validasi kekuatan (≥12 karakter, huruf+angka).

## Yang belum selesai (Tahap 2+)
1. **Penyimpanan akun produksi**: migration `web_users` (hash bcrypt, tanpa plaintext) + accountStore berbasis DB. Sampai itu ada, **login produksi belum berfungsi** — bootstrap script hanya menghasilkan hash.
2. **Integrasi startup**: `src/app.js` belum memuat web app. Rencana: di tahap berikutnya, `src/web/server.js` terpisah (mis. `npm run web:start`) sehingga `npm start` bot tidak berubah perilaku; opsi menyatukan proses dievaluasi bersama BotManager.
3. Rate limiter/sesi in-memory → store bersama bila multi-instance.
4. Audit log aksi admin web (tabel `web_audit_logs`).

## Keamanan yang sudah diterapkan
- Cookie sesi: HttpOnly, SameSite=Strict, Secure di production (butuh HTTPS/proxy), path `/`, TTL dari config.
- Regenerasi session ID + rotasi CSRF token saat login sukses.
- Semua endpoint privat dilindungi; semua POST memvalidasi CSRF server-side.
- Helmet + CSP ketat (`default-src 'self'`, `frame-ancestors 'none'`), HSTS di production.
- Body limit 16kb, tanpa endpoint file/shell/env, tanpa secret default di source.

## Menjalankan test
```
npm test                        # seluruh suite (bot + web)
node --test tests/web/web-admin.test.js   # hanya web
```
Test web tidak menyentuh database, Telegram, atau `.env` — memakai account store in-memory dan HTTP server sementara pada port acak.
