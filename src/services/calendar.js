'use strict';

/**
 * Kalender inline Telegram untuk pemilihan tanggal input lembur (modul murni).
 * Semua tanggal berbasis zona waktu bisnis (Asia/Taipei), BUKAN timezone server.
 * Callback pakai prefiks "cal:" — tidak bertabrakan dengan "pay:" dan "exp:".
 */
const { MONTHS_ID } = require('./overtime-input');
const { toZonedParts } = require('../utils/date-time');

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

/** {y,m,d} hari ini menurut zona waktu aplikasi. */
function todayInTz(timezone) {
  const p = toZonedParts(new Date(), timezone);
  const [y, m, d] = p.date.split('-').map(Number);
  return { y, m, d };
}

/** Parse 'YYYY-MM-DD' ketat + validitas kalender (kabisat via round-trip UTC). */
function parseCalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Tanggal → '11 Oktober 2026'. */
function formatDateId(date) {
  return `${date.d} ${MONTHS_ID[date.m - 1]} ${date.y}`;
}

const key = (date) => `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`;

/**
 * Keyboard kalender untuk bulan (viewY, viewM).
 * Nama hari & posisi tanggal mengikuti kalender nyata (hari pertama kolom Minggu).
 * Kabisat & jumlah hari ditangani oleh aritmetika Date.UTC.
 */
function calendarKeyboard(viewY, viewM) {
  if (!Number.isInteger(viewY) || !Number.isInteger(viewM) || viewM < 1 || viewM > 12) return null;
  const prevM = viewM === 1 ? 12 : viewM - 1;
  const prevY = viewM === 1 ? viewY - 1 : viewY;
  const nextM = viewM === 12 ? 1 : viewM + 1;
  const nextY = viewM === 12 ? viewY + 1 : viewY;
  const pad = (n) => String(n).padStart(2, '0');

  const nav = [
    { text: '◀️', callback_data: `cal:prev:${prevY}-${pad(prevM)}` },
    { text: `${MONTHS_ID[viewM - 1]} ${viewY}`, callback_data: 'cal:noop' },
    { text: '▶️', callback_data: `cal:next:${nextY}-${pad(nextM)}` },
  ];
  const names = DAY_NAMES.map((n) => ({ text: n, callback_data: 'cal:noop' }));

  const daysInMonth = new Date(Date.UTC(viewY, viewM, 0)).getUTCDate();
  const startDow = new Date(Date.UTC(viewY, viewM - 1, 1)).getUTCDay(); // 0 = Minggu
  const rows = [nav, names];
  let week = [];
  for (let i = 0; i < startDow; i += 1) week.push({ text: ' ', callback_data: 'cal:noop' });
  for (let d = 1; d <= daysInMonth; d += 1) {
    week.push({ text: String(d), callback_data: `cal:sel:${viewY}-${pad(viewM)}-${pad(d)}` });
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) {
    while (week.length < 7) week.push({ text: ' ', callback_data: 'cal:noop' });
    rows.push(week);
  }
  rows.push([
    { text: 'Hari Ini', callback_data: 'cal:today' },
    { text: 'Batal', callback_data: 'cal:cancel' },
  ]);
  return rows;
}

module.exports = { todayInTz, parseCalDate, formatDateId, calendarKeyboard, DAY_NAMES };
