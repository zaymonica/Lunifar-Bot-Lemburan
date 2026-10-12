'use strict';

/**
 * Perhitungan akumulasi jam & estimasi upah lembur (TWD / NT$).
 * Modul murni — tidak menyentuh DB/Telegraf.
 *
 * Aturan (jangan diubah tanpa persetujuan):
 * - Tarif per jam = 122 × faktor, disimpan sebagai integer sen:
 *   K1: 122×1,34 = NT$163,48/jam → 16348 sen/jam
 *   K2: 122×1,67 = NT$203,74/jam → 20374 sen/jam
 *   K3: 122×2,67 = NT$325,74/jam → 32574 sen/jam
 * - Pembagian kategori per TANGGAL LOKAL (bukan per periode):
 *   K1 = min(total,120); K2 = min(max(total-120,0),120); K3 = max(total-240,0).
 * - Durasi yang dipakai = durasi AKTUAL seluruh periode valid pada tanggal
 *   tersebut. Kebijakan minimum 30 menit / pembulatan 15 menit pada
 *   payable_minutes per periode TIDAK dipakai di sini dan tidak diubah.
 */

const { toZonedParts } = require('../utils/date-time');
const { MONTHS_ID, formatDurationId, rowNetMinutes } = require('./overtime-input');
const i18n = require('../i18n');

const RATE_BASE = 122;
const FACTORS = { 1: 134, 2: 167, 3: 267 }; // faktor × 100 (integer)
const RATE_CENTS_PER_HOUR = {
  1: RATE_BASE * FACTORS[1], // 16348
  2: RATE_BASE * FACTORS[2], // 20374
  3: RATE_BASE * FACTORS[3], // 32574
};
const RATE_TEXT = { 1: 'NT$163,48', 2: 'NT$203,74', 3: 'NT$325,74' };

/** Bagi total menit harian ke kategori (basis menit integer). */
function splitCategories(totalMinutes) {
  const t = Math.max(0, Math.round(totalMinutes));
  return {
    1: Math.min(t, 120),
    2: Math.min(Math.max(t - 120, 0), 120),
    3: Math.max(t - 240, 0),
  };
}

/** Sen untuk `minutes` menit pada kategori `cat` (pembulatan ke sen terdekat). */
function centsFor(minutes, cat) {
  return Math.round((Math.max(0, minutes) * RATE_CENTS_PER_HOUR[cat]) / 60);
}

/** Pay satu tanggal: { categories: {1:{minutes,cents},...}, totalCents }. */
function dayPay(totalMinutes) {
  const split = splitCategories(totalMinutes);
  const categories = {};
  let totalCents = 0;
  for (const cat of [1, 2, 3]) {
    const cents = centsFor(split[cat], cat);
    categories[cat] = { minutes: split[cat], cents };
    totalCents += cents;
  }
  return { categories, totalCents };
}

/** Format sen → "NT$1.060,18" (ribuan '.', desimal ','). Tanpa "Rp". */
function formatCents(cents) {
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const intPart = Math.floor(abs / 100);
  const dec = String(abs % 100).padStart(2, '0');
  const intStr = String(intPart).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${neg ? '-' : ''}NT$${intStr},${dec}`;
}

/** Key tanggal lokal 'YYYY-MM-DD' untuk instan Date pada zona `timezone`. */
function localDateKey(date, timezone) {
  return toZonedParts(date, timezone).date;
}

/**
 * Agregasi bulanan dari baris sesi. Filter:
 * - butuh end_at (sesi aktif tanpa selesai tidak dihitung),
 * - status 'active'/'rejected' dikecualikan,
 * - dedupe by id (anti penghitungan ganda),
 * - durasi <= 0 diabaikan,
 * - dikelompokkan per tanggal lokal jam MULAI.
 */
function aggregateMonthly(rows, timezone) {
  const byDay = new Map();
  const seen = new Set();
  for (const r of rows) {
    if (!r.end_at || r.status === 'active' || r.status === 'rejected') continue;
    if (r.id != null) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
    }
    const { net } = rowNetMinutes(r); // durasi bersih = kotor − istirahat (titik tunggal)
    if (!(net > 0)) continue;
    const key = localDateKey(new Date(r.start_at), timezone);
    const day = byDay.get(key) || { key, totalMinutes: 0 };
    day.totalMinutes += net;
    byDay.set(key, day);
  }
  const days = [...byDay.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  let totalMinutes = 0;
  let totalCents = 0;
  const catMinutes = { 1: 0, 2: 0, 3: 0 };
  const catCents = { 1: 0, 2: 0, 3: 0 };
  for (const d of days) {
    d.pay = dayPay(d.totalMinutes);
    totalMinutes += d.totalMinutes;
    totalCents += d.pay.totalCents;
    for (const c of [1, 2, 3]) {
      catMinutes[c] += d.pay.categories[c].minutes;
      catCents[c] += d.pay.categories[c].cents;
    }
  }
  return {
    days,
    totals: { minutes: totalMinutes, categories: catMinutes, catCents, totalCents, dayCount: days.length },
  };
}

/** Susun teks rekap bulanan. Aman untuk pesan >4096 karakter (dipangkas). */
function formatMonthlyText(agg, year, month, lang = 'id') {
  const monthLabel = i18n.monthName(lang, month);
  const t = agg.totals;
  const catAmount = (c) => formatCents(t.catCents ? t.catCents[c] : (t.categories[c] ? centsFor(t.categories[c], c) : 0));
  const lines = [
    i18n.t(lang, 'pay.title', { month: monthLabel, year }),
    '',
    i18n.t(lang, 'pay.totalHours', { duration: formatDurationId(t.minutes, lang) }),
    i18n.t(lang, 'pay.category', { cat: 1, duration: formatDurationId(t.categories[1], lang), rate: RATE_TEXT[1], amount: catAmount(1) }),
    i18n.t(lang, 'pay.category', { cat: 2, duration: formatDurationId(t.categories[2], lang), rate: RATE_TEXT[2], amount: catAmount(2) }),
    i18n.t(lang, 'pay.category', { cat: 3, duration: formatDurationId(t.categories[3], lang), rate: RATE_TEXT[3], amount: catAmount(3) }),
    i18n.t(lang, 'pay.totalPay', { amount: formatCents(t.totalCents) }),
    i18n.t(lang, 'pay.dayCount', { count: t.dayCount }),
  ];
  if (!agg.days.length) {
    lines.push('', i18n.t(lang, 'pay.empty', { month: monthLabel, year }));
    return lines.join('\n');
  }
  lines.push('', i18n.t(lang, 'pay.dailyTitle'));
  const daily = agg.days.map((d) => {
    const p = d.pay.categories;
    return i18n.t(lang, 'pay.dailyLine', {
      date: `${d.key.slice(8, 10)}-${d.key.slice(5, 7)}`,
      duration: formatDurationId(d.totalMinutes, lang),
      k1min: p[1].minutes, k1amt: formatCents(p[1].cents),
      k2min: p[2].minutes, k2amt: formatCents(p[2].cents),
      k3min: p[3].minutes, k3amt: formatCents(p[3].cents),
    });
  });
  const MAX_DAILY = 3500;
  let shown = daily;
  while (shown.length > 1 && shown.join('\n').length > MAX_DAILY) shown = shown.slice(0, -1);
  let note = '';
  if (shown.length < daily.length) {
    note = `\n${i18n.t(lang, 'pay.truncated', { count: daily.length - shown.length })}`;
  }
  lines.push(...shown, note);
  return lines.join('\n');
}

/** Keyboard navigasi bulan: prev selalu; next hanya bila bulan < bulan berjalan. */
function navKeyboard(year, month, currentYear, currentMonth, lang = 'id') {
  const shift = (y, m, delta) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
  };
  const mm = String(month).padStart(2, '0');
  const prev = shift(year, month, -1);
  const row = [{ text: i18n.t(lang, 'pay.prevMonth'), callback_data: `pay:${prev.y}-${String(prev.m).padStart(2, '0')}` }];
  if (year * 12 + month < currentYear * 12 + currentMonth) {
    const next = shift(year, month, 1);
    row.push({ text: i18n.t(lang, 'pay.nextMonth'), callback_data: `pay:${next.y}-${String(next.m).padStart(2, '0')}` });
  }
  // Tombol export: meng-export bulan yang sedang ditampilkan, bukan bulan berjalan.
  return [row, [{ text: i18n.t(lang, 'pay.export'), callback_data: `exp:${year}-${mm}` }]];
}

/** Validasi parameter bulan callback 'YYYY-MM' → {y,m} atau null. */
function parseMonthParam(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12) return null;
  return { y, m: mo };
}

/** Anggaran menit per kategori (urut K1→K3). */
const CATEGORY_BUDGETS = [120, 120, Infinity];
const CATEGORY_STARTS = [0, 120, 240];

/**
 * Bagi tiap periode (sudah terurut kronologis, satu tanggal lokal) ke kategori
 * berdasarkan posisi kumulatif harian — konsisten dengan splitCategories(total):
 * jumlah alokasi seluruh periode pada satu tanggal === splitCategories(total).
 * Return array per periode: {1:{minutes,cents},2:...,3:...,totalCents}.
 */
function allocatePeriods(periods) {
  let running = 0;
  return periods.map((p) => {
    const minutes = Math.max(0, Math.round(p.minutes));
    const alloc = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < 3; i += 1) {
      const lo = Math.max(running, CATEGORY_STARTS[i]);
      const hi = Math.min(running + minutes, CATEGORY_STARTS[i] + CATEGORY_BUDGETS[i]);
      alloc[i + 1] = Math.max(0, hi - lo);
    }
    running += minutes;
    const cents = { 1: centsFor(alloc[1], 1), 2: centsFor(alloc[2], 2), 3: centsFor(alloc[3], 3) };
    return { minutes, ...cents, categories: alloc, centsByCat: cents, totalCents: cents[1] + cents[2] + cents[3] };
  });
}

module.exports = {
  RATE_BASE, FACTORS, RATE_CENTS_PER_HOUR, RATE_TEXT,
  splitCategories, centsFor, dayPay, formatCents, localDateKey,
  aggregateMonthly, formatMonthlyText, navKeyboard, parseMonthParam, allocatePeriods,
};
