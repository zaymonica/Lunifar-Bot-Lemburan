# Panduan Deployment cPanel — Lunifar Overtime Bot

Panduan ini untuk shared hosting cPanel dengan Node.js Application Manager (atau "Setup Node.js App"). Lakukan hanya setelah aplikasi lulus pengujian lokal.

## 1. Buat database MySQL & user

1. cPanel → **MySQL® Databases**.
2. Buat database, mis. `namacpanel_overtime` (prefiks akun otomatis).
3. Buat user database dengan password kuat (gunakan password generator cPanel; simpan di password manager).
4. Add User To Database → beri privilege **ALL PRIVILEGES** pada database itu saja (user ini hanya dipakai aplikasi ini). Jangan gunakan user root cPanel.

## 2. Unggah source code

1. Upload proyek ke folder **di luar** `public_html`, mis. `/home/USER/overtime-bot`. Source code (termasuk `.env`) tidak boleh berada di document root publik.
2. Kecualikan `node_modules/`, `.git/`, `tests/` saat upload (opsional); `node_modules` akan di-install ulang di server.
3. Buat file `.env` di server berisi nilai produksi (jangan salin `.env` lokal yang berisi token dev). Atau set environment variables lewat Node.js Application Manager (langkah 4).

## 3. Pilih versi Node.js

1. cPanel → **Setup Node.js App** → Create Application.
2. Node.js version: pilih **18.x atau lebih baru**.
3. Application root: `/home/USER/overtime-bot`.
4. Application URL: bisa dibiarkan default (bot tidak butuh URL publik; komunikasi keluar ke Telegram).
5. Application startup file: **`src/app.js`**.

## 4. Environment variables

Di halaman Setup Node.js App, tambahkan environment variables (atau buat `.env` di application root — aplikasi memakai dotenv):

```
BOT_TOKEN=<token dari BotFather>
ADMIN_TELEGRAM_IDS=<id telegram admin, dipisah koma>
DB_HOST=localhost
DB_PORT=3306
DB_USER=<user cPanel>
DB_PASSWORD=<password>
DB_NAME=<nama database>
DB_CONNECTION_LIMIT=5
APP_TIMEZONE=Asia/Jakarta
LOG_LEVEL=info
NODE_ENV=production
```

## 5. Install dependency

Dari halaman Node.js App klik **Run NPM Install**, atau lewat terminal cPanel:

```
cd ~/overtime-bot
source /home/USER/nodevenv/overtime-bot/18/bin/activate
npm install --omit=dev
```

## 6. Jalankan migration (terkendali, sekali)

```
npm run db:migrate
npm run db:check   # verifikasi
```

Migration idempoten (dicatat di `schema_migrations`). Jangan jalankan berkali-kali secara paralel.

## 7. Aktifkan aplikasi

1. Klik **Start** (atau Restart) di Node.js App.
2. Bot berjalan sebagai proses persisten dengan **long polling**. Tidak butuh webhook/HTTPS routing.

## 8. Cek log & restart

- Log error aplikasi: lihat di halaman Setup Node.js App (link log), atau `~/overtime-bot/stderr.log` sesuai konfigurasi hosting.
- Setiap perubahan kode atau `.env`: klik **Restart**.
- `409 Conflict` di log = ada dua instance polling dengan token sama. Pastikan hanya satu: matikan instance lokal/sebelumnya sebelum mengaktifkan di cPanel.

## 9. Backup & pemulihan

- Database: cPanel → phpMyAdmin → Export (reguler, mis. mingguan), atau cron job `mysqldump`.
- Source: simpan di Git repository privat (tanpa `.env`).
- Pemulihan: deploy ulang source → restore dump MySQL → isi environment variables → jalankan `npm install` → `npm run db:migrate` → Start.

## 10. Checklist pasca-deploy

- [ ] `npm run db:check` sukses di server.
- [ ] Bot merespon `/start` di Telegram.
- [ ] Registrasi admin pertama disetujui.
- [ ] `/admin` menampilkan panel.
- [ ] Hanya satu instance berjalan.
- [ ] Log tidak menampilkan token/password.
