'use strict';

/**
 * Pembuat workbook Excel riwayat lembur pribadi (ExcelJS, in-memory — tanpa
 * file sementara). Format sederhana sesuai referensi perusahaan:
 *   Tanggal | Jam Mulai | Jam Selesai | Jam 1 | Jam 2 | Jam 3 | Total Jam
 * Satu baris per periode, diurutkan berdasarkan tanggal & jam mulai.
 * Pembagian Jam 1/2/3 memakai allocatePeriods() yang sama dengan payroll —
 * TIDAK ada rumus baru. Tanpa kolom nama/departemen/upah/catatan.
 */
const ExcelJS = require('exceljs');
const { allocatePeriods, localDateKey } = require('./payroll');
const { rowNetMinutes } = require('./overtime-input');
const { toZonedParts } = require('../utils/date-time');

const HOUR_FMT = '0.0';
const pad2 = (n) => String(n).padStart(2, '0');

/** Jam desimal 1 angka dari menit (angka numerik untuk Excel). */
const hoursNum = (minutes) => Math.round(minutes) / 60;

/**
 * Susun baris data dari sesi mentah satu bulan.
 * Filter & dedupe konsisten dengan aggregateMonthly:
 * - harus punya end_at, status bukan active/rejected,
 * - dedupe by id, durasi bersih > 0.
 * Kembalikan array { dateKey, date, start, end, k1, k2, k3, totalMinutes }
 * terurut berdasarkan tanggal lalu jam mulai (menit kategori integer).
 */
function buildHistoryRows(rows, timezone) {
  const byDay = new Map();
  const seen = new Set();
  for (const r of rows) {
    if (!r.end_at || r.status === 'active' || r.status === 'rejected') continue;
    if (r.id != null) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
    }
    const { net } = rowNetMinutes(r);
    if (!(net > 0)) continue;
    const key = localDateKey(new Date(r.start_at), timezone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({ r, net });
  }
  const out = [];
  const dayKeys = [...byDay.keys()].sort();
  for (const key of dayKeys) {
    const list = byDay.get(key).sort((a, b) => new Date(a.r.start_at) - new Date(b.r.start_at));
    // Alokasi kategori harian konsisten dengan splitCategories(total) — rumus lama.
    const allocs = allocatePeriods(list.map((x) => ({ minutes: x.net })));
    list.forEach((x, i) => {
      const a = allocs[i];
      const k1 = a.categories[1];
      const k2 = a.categories[2];
      const k3 = a.categories[3];
      const ps = toZonedParts(new Date(x.r.start_at), timezone);
      const pe = toZonedParts(new Date(x.r.end_at), timezone);
      out.push({
        dateKey: key,
        date: `${key.slice(8, 10)}-${key.slice(5, 7)}-${key.slice(0, 4)}`,
        start: ps.time.slice(0, 5),
        end: pe.time.slice(0, 5),
        k1, k2, k3,
        totalMinutes: k1 + k2 + k3,
      });
    });
  }
  return out;
}

/**
 * Bangun workbook. Batas baris 2000 (proteksi resource; baris pertama = header,
 * baris terakhir = TOTAL dengan formula SUM).
 */
async function buildHistoryWorkbook({ data, lang, year, month }) {
  const i18n = require('../i18n');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lunifar Overtime Bot';
  const ws = wb.addWorksheet('Riwayat');
  const tr = (key) => i18n.t(lang, key);
  const headers = [tr('hexp.date'), tr('hexp.start'), tr('hexp.end'), tr('hexp.h1'), tr('hexp.h2'), tr('hexp.h3'), tr('hexp.total')];
  const headerRow = ws.addRow(headers);
  headerRow.font = { bold: true };
  [12, 10, 10, 8, 8, 8, 10].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  [4, 5, 6, 7].forEach((c) => { ws.getColumn(c).numFmt = HOUR_FMT; });

  const MAX_ROWS = 2000;
  const shown = data.slice(0, MAX_ROWS);
  let r = 1;
  for (const d of shown) {
    r += 1;
    // Total per baris = formula SUM(D:F) → selalu sama dengan jumlah kategori.
    ws.addRow([
      d.date, d.start, d.end,
      hoursNum(d.k1), hoursNum(d.k2), hoursNum(d.k3),
      { formula: `SUM(D${r}:F${r})` },
    ]);
  }
  // Baris TOTAL: penjumlahan seluruh baris per kolom jam.
  if (shown.length) {
    const first = 2;
    const last = shown.length + 1;
    const totalRow = ws.addRow([
      tr('excel.total'), '', '',
      { formula: `SUM(D${first}:D${last})` },
      { formula: `SUM(E${first}:E${last})` },
      { formula: `SUM(F${first}:F${last})` },
      { formula: `SUM(G${first}:G${last})` },
    ]);
    totalRow.font = { bold: true };
    [4, 5, 6, 7].forEach((c) => { totalRow.getCell(c).numFmt = HOUR_FMT; });
  }
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer: Buffer.from(buffer), shown, truncated: data.length - shown.length };
}

/** Nama file aman Telegram: hanya huruf/angka/minus/garis bawah/titik. */
function historyFileName(year, month) {
  return `riwayat_lembur_${year}-${pad2(month)}.xlsx`;
}

module.exports = { buildHistoryRows, buildHistoryWorkbook, historyFileName, HOUR_FMT };
