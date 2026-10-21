# Web Admin — Tahap 2 (Penyimpanan Akun Database)

Status: repository `web_users` + guard target + bootstrap terintegrasi **selesai dan teruji** (13 test baru; total 199 lulus). Database produksi cPanel tidak disentuh.

## Yang baru
- `database/migrations/004_web_users.sql` — **additive-only**: `web_users(id, username UNIQUE, password_hash, is_active, created_at, updated_at)`. Tidak mengubah tabel/migration lama. Password hanya disimpan sebagai bcrypt hash; username disimpan ternormalisasi lowercase oleh aplikasi.
- `src/web/web-user.repo.js` — `WebUserRepository` (prepared statements via `pool.execute`) + `createDbAccountStore(repo)` adapter ke interface `accountStore` `createWebApp()` (normalisasi trim+lowercase).
- `src/config/env.js` — guard baru `assertWebWriteTarget(dbName, nodeEnv, confirmEnv)`: development hanya menulis ke `DEV_ALLOWED_MIGRATION_DBS` (`lunifar_overtime_test`); lingkungan lain wajib `WEB_TARGET_CONFIRM=YES` (verifikasi manual). Guard dipanggil **sebelum** koneksi DB dibuka (fail-fast).
- `scripts/web-bootstrap-admin.js` — kini benar-benar menulis ke DB: loadEnv → guard target → pool mysql2 (bukan pool bot, tanpa multipleStatements) → `createAdminUser()` (validasi username/password, hash bcrypt cost 12, tolak duplikat via pre-check + kode `ER_DUP_ENTRY`). Password tetap interaktif tanpa echo, bukan argumen CLI; output hanya username, **tanpa password/hash/kredensial**.
- `src/web/routes/auth.js` — akun `isActive === false` ditolak sebagai kegagalan login biasa (respons generik, tanpa membocorkan status akun).
- `tests/web/web-users-db.test.js` — 13 test dengan pool mock (tanpa DB nyata, tanpa Telegram): repo (found/not-found/inactive/dup/params binding), adapter, `createAdminUser` (sukses/dup/lemah/invalid), guard (dev testing ok, DB tak dikenal ditolak, produksi tanpa `WEB_TARGET_CONFIRM=YES` ditolak), HTTP end-to-end via DB store (login sukses + session ID berubah + hash tidak pernah muncul di respons, nonaktif 401 generik, password salah generik, CSRF wajib, logout efektif, username tak dikenal 401).

## Menjalankan (lokal, DB testing)
```
npm run db:migrate                      # hanya boleh ke DB_NAME=lunifar_overtime_test saat NODE_ENV=development
node scripts/web-bootstrap-admin.js     # guard menolak DB selain testing
```

## Evaluasi session store persisten (belum diimplementasikan)
Kondisi saat ini: `express-session` default **MemoryStore** — sesi hilang saat restart; cukup untuk satu proses Passenger di cPanel, tidak aman untuk multi-instance.
- **Rekomendasi (nanti, Tahap 3+): `express-mysql-session`** — compatible MySQL/MariaDB, sinkron dengan stack DB yang sudah ada (mysql2), tabel `sessions` terpisah via migration additive, mendukung `clearExpired`. Dipilih di atas Redis/Memcached karena cPanel shared hosting umumnya tidak menyediakan Redis.
- Belum ditambahkan karena: (a) perlu evaluasi versi MariaDB cPanel vs library, (b) menambah dependency & tabel baru yang sebaiknya direview bersama, (c) manfaatnya terbatas pada skenario multi-instance yang belum ada. **Sesi produksi persisten BELUM tersedia** — jangan berasumsi sesi bertahan melewati restart.

## Belum siap untuk produksi
1. Migration 004 dan bootstrap **belum pernah dijalankan** pada DB mana pun dalam sesi ini (sesuai batasan: tidak ada eksekusi tanpa target testing eksplisit). Jalankan manual ke `lunifar_overtime_test` dulu.
2. `createWebApp()` belum dipasang di startup server (masih rencana `src/web/server.js`).
3. Session store persisten (lihat atas) dan audit log aksi admin belum ada.
4. Regenerasi password / manajemen multi-admin lewat UI belum ada (setActive tersedia di repo).
