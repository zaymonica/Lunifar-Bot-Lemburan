'use strict';

/**
 * Sistem i18n terpusat untuk Lunifar Overtime Bot.
 * - Fallback selalu ke 'id' (Bahasa Indonesia) untuk key/bahasa yang hilang.
 * - t() tidak pernah melempar error; key tak dikenal dikembalikan apa adanya.
 * - trError() menerjemahkan pesan error service (bahasa Indonesia) berdasarkan
 *   pemetaan string persis — additive, tidak mengubah sumber pesan.
 */

const ID = require('./catalogs/id');
const EN = require('./catalogs/en');
const ZH_TW = require('./catalogs/zh-TW');
const VI = require('./catalogs/vi');

const CATALOGS = { id: ID, en: EN, 'zh-TW': ZH_TW, vi: VI };
const DEFAULT_LANG = 'id';

/** Daftar bahasa untuk keyboard pemilihan (urut tampilan). */
const LANGUAGES = [
  { code: 'id', buttonKey: 'language.buttonId' },
  { code: 'en', buttonKey: 'language.buttonEn' },
  { code: 'zh-TW', buttonKey: 'language.buttonZhTW' },
  { code: 'vi', buttonKey: 'language.buttonVi' },
];

/** Normalisasi kode bahasa; fallback ke 'id' untuk nilai tidak dikenal. */
function normalizeLang(lang) {
  return CATALOGS[String(lang || '').trim()] ? String(lang).trim() : DEFAULT_LANG;
}

/** Terjemahkan key dengan interpolasi {param}. Fallback: id → key mentah. */
function t(lang, key, params) {
  const l = normalizeLang(lang);
  const cat = CATALOGS[l];
  let text = (cat.keys && cat.keys[key] !== undefined) ? cat.keys[key] : undefined;
  if (text === undefined) text = CATALOGS[DEFAULT_LANG].keys[key];
  if (text === undefined) return key;
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.split(`{${k}}`).join(v === undefined || v === null ? '' : String(v));
    }
  }
  return text;
}

/** Nama tampilan bahasa (mis. 'Tiếng Việt'). */
function langDisplayName(lang) {
  const cat = CATALOGS[normalizeLang(lang)];
  return cat.langName || CATALOGS[DEFAULT_LANG].langName;
}

/** Nama bulan lokal (1-12). */
function monthName(lang, month) {
  const l = normalizeLang(lang);
  const months = (CATALOGS[l].months && CATALOGS[l].months.length === 12)
    ? CATALOGS[l].months : CATALOGS[DEFAULT_LANG].months;
  return months[(Math.min(Math.max(month, 1), 12)) - 1];
}

/** Nama hari singkat untuk header kalender (Minggu-first). */
function dayNames(lang) {
  const l = normalizeLang(lang);
  const d = (CATALOGS[l].days && CATALOGS[l].days.length === 7)
    ? CATALOGS[l].days : CATALOGS[DEFAULT_LANG].days;
  return d.slice();
}

/** Format durasi menit ramah bahasa: "2 jam 30 menit" / "2h 30min" / dst. */
function formatDuration(minutes, lang) {
  const l = normalizeLang(lang);
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const words = CATALOGS[l].duration || CATALOGS[DEFAULT_LANG].duration;
  if (h > 0 && r > 0) return `${h} ${words.hours} ${r} ${words.minutes}`;
  if (h > 0) return `${h} ${words.hours}`;
  return `${r} ${words.minutes}`;
}

/** Format {y,m,d} → teks tanggal sesuai pola bahasa. */
function formatDate(lang, date) {
  const l = normalizeLang(lang);
  const pattern = CATALOGS[l].datePattern || CATALOGS[DEFAULT_LANG].datePattern;
  return pattern
    .split('{y}').join(String(date.y))
    .split('{month}').join(monthName(l, date.m))
    .split('{d}').join(String(date.d));
}

/**
 * Pemetaan pesan error internal (Indonesia) → key i18n.
 * String persis sesuai yang dilempar service/parser. Pesan tak terdaftar
 * dikembalikan apa adanya (aman untuk bahasa apa pun).
 */
const ERROR_MAP = new Map(Object.entries({
  // employee.service / errors
  'Telegram user ID tidak valid.': 'err.tgIdInvalid',
  'Anda sudah terdaftar.': 'err.alreadyRegistered',
  'Anda belum terdaftar. Gunakan /start untuk mendaftar.': 'err.notRegisteredStart',
  'Registrasi Anda ditolak sebelumnya. Daftar ulang dengan /daftar.': 'err.registerRejected',
  'Akun Anda tidak aktif.': 'err.accountInactive',
  'Akun Anda belum aktif. Gunakan /start untuk mendaftar atau hubungi admin.': 'err.accountNotActive',
  'Perintah ini hanya untuk admin.': 'err.adminOnly',
  'Data tidak ditemukan.': 'err.notFound',
  'Terjadi kesalahan database. Silakan coba lagi.': 'err.dbError',
  'Anda tidak memiliki akses untuk aksi ini.': 'err.noAccess',
  'Terjadi kesalahan internal. Silakan coba lagi nanti.': 'common.internalError',
  // overtime.service
  'Anda masih memiliki sesi lembur aktif. Selesaikan dulu dengan "Selesai Lembur".': 'err.activeSession',
  'Tidak ada sesi lembur aktif. Mulai lembur dulu.': 'err.noActiveSession',
  'Sesi sudah diselesaikan sebelumnya.': 'err.sessionFinished',
  'Catatan lembur maksimal 500 karakter.': 'err.noteTooLong',
  'Durasi istirahat harus kurang dari durasi kotor lembur (durasi bersih tidak boleh 0 atau negatif).': 'err.breakTooLong',
  'Periode lembur yang identik (mulai & selesai sama) sudah tercatat untuk tanggal ini.': 'err.dupPeriod',
  'ID catatan tidak valid.': 'err.invalidId',
  'Catatan lembur tidak ditemukan.': 'err.rowNotFound',
  'Anda hanya dapat mengedit catatan lembur milik Anda sendiri.': 'err.notOwner',
  // approval.service
  'Sesi lembur tidak ditemukan.': 'err.rowNotFound',
  'Hanya sesi berstatus pending yang dapat diputuskan.': 'err.onlyPending',
  'Anda tidak dapat menyetujui lembur Anda sendiri.': 'err.selfApproval',
  'Hanya admin/atasan yang dapat menyetujui lembur.': 'err.approverOnly',
  'Sesi sudah diproses oleh admin lain.': 'err.sessionProcessed',
  'Karyawan tidak ditemukan.': 'err.empNotFound',
  'Registrasi ini sudah diproses.': 'err.regProcessed',
  // overtime-input
  'Format tanggal harus DD-MM-YYYY, contoh: 01-10-2026.': 'err.dateFormat',
  'Tahun di luar rentang wajar (2000-2100).': 'err.yearRange',
  'Bulan tidak valid.': 'err.monthInvalid',
  'Tanggal tidak valid untuk kalender (mis. 31-02).': 'err.dateInvalidCal',
  'Format jam harus HH:MM (00:00-23:59), contoh: 16:30.': 'err.timeFormat',
  'Jam tidak valid — gunakan HH:MM (00:00-23:59).': 'err.timeInvalid',
  'Tanggal tidak valid.': 'err.dateInvalid',
  'Jam selesai sama dengan jam mulai — durasi tidak boleh 0 menit.': 'err.zeroDuration',
  'Durasi lembur tidak valid (selesai tidak boleh sebelum/sama dengan mulai).': 'err.invalidDuration',
  // report.service
  'Tanggal "dari" harus sebelum "sampai".': 'err.dateOrder',
  'Status tidak valid.': 'err.statusInvalid',
  'Departemen tidak valid.': 'err.deptInvalid',
  'Tidak ada data untuk filter ini.': 'err.noDataFilter',
}));

/**
 * Terjemahkan pesan error berbahasa Indonesia ke bahasa target.
 * Mendukung pesan dengan sufix status dinamis:
 *   'Catatan dengan status "pending" tidak dapat diedit.' → err.notEditable
 *   'Keputusan sudah dibuat sebelumnya (status: approved).' → err.alreadyDecided
 *   'Status catatan berubah menjadi "..." sebelum disimpan — edit dibatalkan.' → err.statusChanged
 */
function trError(lang, message) {
  if (!message) return '';
  const msg = String(message);
  let m = /^(?:Catatan dengan status|Status catatan berubah menjadi) "(.+?)" (?:tidak dapat diedit\.|sebelum disimpan — edit dibatalkan\.)$/.exec(msg);
  if (m) return t(lang, 'err.notEditable', { status: m[1] });
  m = /^Keputusan sudah dibuat sebelumnya \(status: (.+?)\)\.$/.exec(msg);
  if (m) return t(lang, 'err.alreadyDecided', { status: m[1] });
  // Pesan berparameter 'X wajib diisi.' / 'X maksimal N karakter.'
  m = /^(.+) wajib diisi\.$/.exec(msg);
  if (m) return t(lang, 'err.labelRequired', { label: m[1] });
  m = /^(.+) maksimal (\d+) karakter\.$/.exec(msg);
  if (m) return t(lang, 'err.labelMaxLen', { label: m[1], max: m[2] });
  const key = ERROR_MAP.get(msg);
  if (key) return t(lang, key);
  return msg;
}

module.exports = {
  DEFAULT_LANG, LANGUAGES, CATALOGS,
  normalizeLang, t, monthName, dayNames, formatDuration, formatDate, trError, langDisplayName,
};
