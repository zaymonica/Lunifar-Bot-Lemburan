# Lunifar Overtime Bot

Bot Telegram untuk pencatatan, persetujuan, perhitungan, dan pelaporan lembur karyawan. Dibangun dengan Node.js 18+, Telegraf 4, MySQL (mysql2), dan ExcelJS. Kompatibel dengan shared hosting cPanel (Node.js Application Manager).

## Fitur yang sudah diimplementasikan

- Registrasi karyawan via `/start` & `/daftar Nama | NIK | Departemen`, status awal **pending**, disetujui/ditolak admin.
- Pencatatan lembur: Mulai / Selesai / Status / Riwayat / Profil / Bantuan (reply keyboard).
- Durasi dihitung dari timestamp server (UTC), bukan input teks. Pembulatan & minimum lembur via konfigurasi; nilai rupiah TIDAK dihitung otomatis (butuh tarif perusahaan).
- Pencegahan sesi ganda via unique index database (`employee_id` + kolom generated `active_flag`) — aman dari race condition.
- Persetujuan lembur: alur `active → pending → approved/rejected` (final). Tidak ada self-approval. Hanya admin/atasan (role `admin`/`supervisor` atau ID di `ADMIN_TELEGRAM_IDS`).
- Audit log untuk registrasi, aksi admin, mulai/selesai/persetujuan lembur.
- Dashboard admin via Telegram: `/admin`, `/karyawan`, `/pending`, `/export DARI SAMPAI [departemen|status]`, `/rekap DARI SAMPAI`.
- Ekspor Excel (ExcelJS) dengan filter periode/departemen/status, ringkasan total, file sementara dihapus setelah dikirim.
- Notifikasi ke karyawan & admin; kegagalan kirim tidak membatalkan operasi database; rate-limit 429 di-retry (maks 2x).
- Idempotensi callback (callbackQuery.id di-cache 10 menit) — mencegah double-click/replay.
- Validasi environment saat startup; fail-fast dengan pesan jelas.
- 31 unit/integration test (mock, tanpa DB/Telegram asli) — semuanya lulus.

## Arsitektur

```
src/
  app.js                  # bootstrap: env → pool → services → bot (polling)
  bot/
    index.js              # Telegraf + middleware + registrasi handler
    keyboards.js          # reply keyboard & pola callback_data
    middleware/auth.js    # auth, requireAdmin, guard idempotensi callback
    handlers/             # common (start/daftar/profil), overtime, admin
  config/                 # env.js (validasi), database.js (pool mysql2, timezone Z)
  repositories/           # SQL prepared statements
  services/               # business logic (employee, overtime, approval, report, notification)
  utils/                  # logger, errors, date-time (UTC↔zona), duration
database/
  schema.sql              # skema referensi
  migrations/001_init.sql # migrasi idempoten (dicatat di schema_migrations)
scripts/                  # validate-env, db-check, db-migrate
tests/                    # node:test dengan mock repositori
```

Alur status lembur: `active` (baru mulai) → `pending` (selesai, menunggu) → `approved` / `rejected` (final). Self-approval ditolak di service layer.

Waktu disimpan **UTC** di MySQL; konversi ke `APP_TIMEZONE` hanya di tampilan/laporan.

## Persyaratan

- Node.js ≥ 18 (diuji dengan Node 24 di mesin pengembangan).
- MySQL 5.7+/8.0 atau MariaDB 10.2+ (mendukung generated column).
- Akun Telegram bot (via BotFather).

## Instalasi lokal (Windows / VS Code)

1. Salin `.env.example` → `.env`, isi semua nilai.
2. `npm install`
3. `npm run validate-env` — cek konfigurasi.
4. `npm run db:migrate` — buat tabel (idempoten, aman diulang).
5. `npm run db:check` — verifikasi koneksi.
6. `npm test` — jalankan pengujian.
7. `npm start` — jalankan bot (long polling).

## Konfigurasi environment (`.env`)

| Variabel | Wajib | Keterangan |
|---|---|---|
| BOT_TOKEN | ✅ | Token dari BotFather. Jangan pernah di-commit. |
| ADMIN_TELEGRAM_IDS | ✅(prod) | Telegram user ID admin awal, dipisah koma (cek via @userinfobot). |
| DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME | ✅ | Kredensial MySQL. `DB_PASSWORD` **boleh string kosong** untuk MySQL lokal tanpa password (mis. XAMPP root), tetapi variabelnya tetap harus ada. |
| DB_CONNECTION_LIMIT | – | Default 5. |
| APP_TIMEZONE | – | Default `Asia/Jakarta`. |
| LOG_LEVEL | – | error/warn/info/debug. |
| NODE_ENV | – | development/production. |
| OVERTIME_MIN_MINUTES | – | Default 30. Di bawah ini → payable null. |
| OVERTIME_ROUNDING_MINUTES | – | Default 15, pembulatan ke atas untuk pelaporan. |
| OVERTIME_MAX_HOURS_PER_DAY | – | Default 8 (belum divalidasi otomatis — lihat Keterbatasan). |

**Asumsi bisnis (diubah via env):** minimum lembur 30 menit, pembulatan 15 menit ke atas. Tidak ada perhitungan rupiah karena tarif belum diberikan.

## Pembuatan bot via BotFather

1. Chat @BotFather → `/newbot` → salin token ke `BOT_TOKEN`.
2. `/setcommands` → kirim daftar perintah: start, daftar, mulai, selesai, status, history, profile, admin, karyawan, pending, export, rekap, help.
3. Ambil Telegram user ID Anda dan masukkan ke `ADMIN_TELEGRAM_IDS`.

## Pengujian

`npm test` — semua test memakai mock (tidak menyentuh DB/Telegram asli). Yang butuh lingkungan nyata:

- `npm run db:check` — butuh MySQL sesuai `.env`.
- Menjalankan bot & menekan menu — butuh token valid. **UNVERIFIED**: alur end-to-end Telegram belum diuji dengan token asli.

Migration TIDAK dijalankan otomatis saat test. Jangan menjalankan `db:migrate` ke database produksi saat pengembangan.

## Deployment cPanel

Lihat **docs/DEPLOYMENT_CPANEL.md**. Ringkas: buat DB & user di cPanel → upload source (di luar document root publik) → set environment variables di Node.js Application Manager → `npm install` → migration sekali → startup file `src/app.js` → pastikan **hanya satu instance** berjalan (dua polling bersamaan = konflik 409).

## Troubleshooting

| Masalah | Penyebab & solusi |
|---|---|
| `Konfigurasi environment wajib belum tersedia` | Lengkapi `.env`, jalankan `npm run validate-env`. |
| Koneksi database gagal | Periksa DB_*; di cPanel host biasanya `localhost`, user berprefiks akun cPanel. |
| Bot tidak merespons | Pastikan tidak ada 2 proses dengan token sama; cek log cPanel. |
| `409 Conflict` dari Telegram | Ada polling ganda. Matikan instance lain. |
| Notifikasi tidak terkirim | Karyawan mungkin belum /start bot, atau akun nonaktif. |

## Backup & keamanan

- Backup database via cPanel phpMyAdmin → Export, atau cron `mysqldump`.
- `.env` tidak masuk Git (ada di `.gitignore`). Tidak ada secret di source code.
- Audit log menyimpan jejak semua aksi admin.

## Keterbatasan yang masih ada

1. **Tarif upah lembur (rupiah) belum dihitung** — menunggu tarif resmi. `payable_minutes` hanya durasi menit sesuai kebijakan.
2. `OVERTIME_MAX_HOURS_PER_DAY` belum divalidasi otomatis saat mulai lembur (placeholder kebijakan).
3. Penetapan role `supervisor` masih via SQL manual: `UPDATE employees SET role='supervisor' WHERE id=...`.
4. End-to-end dengan Telegram & MySQL asli belum diverifikasi (butuh token & DB nyata). Semua test memakai mock.
5. Webhook belum diimplementasikan — default polling.
6. Filter laporan per NIK tersedia di service (`buildFilters`) tetapi belum diekspos di perintah `/export`.
7. Kegagalan notifikasi hanya di-log, belum ada antrian retry permanen.
