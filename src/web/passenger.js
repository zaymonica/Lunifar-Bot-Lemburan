'use strict';

/**
 * Entry point khusus cPanel Passenger (Phusion).
 *
 * Passenger menjalankan file ini sebagai aplikasi Node. Base URI
 * (PASSENGER_BASE_URI, mis. /overtime-bot) diteruskan via env — dipakai oleh
 * src/web/index.js untuk menghapus prefix dari path sebelum routing.
 * Tidak membuka port sendiri (Passenger mengelola socket), tidak menjalankan
 * bot, tidak memuat .env tambahan (env diset di cPanel).
 */

process.env.WEB_BASE_PATH = process.env.WEB_BASE_PATH
  || (process.env.PASSENGER_BASE_URI ? process.env.PASSENGER_BASE_URI.replace(/\/+$/, '') : '/overtime-bot');

const { main } = require('./server');

if (require.main === module) {
  main().catch((err) => {
    console.error('[FATAL]', err.message);
    process.exit(1);
  });
}

module.exports = { main };
