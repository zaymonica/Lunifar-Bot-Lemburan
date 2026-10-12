'use strict';

/**
 * Pembuat workbook Excel rekap lembur bulanan (ExcelJS, in-memory).
 * Semua angka payroll diambil dari fungsi src/services/payroll.js yang sama
 * dengan rekap Telegram — tidak ada rumus bisnis yang digandakan di sini.
 */
const ExcelJS = require('exceljs');
const {
  RATE_TEXT, aggregateMonthly, allocatePeriods, localDateKey,
} = require('./payroll');
const { toZonedParts } = require('../utils/date-time');
const { MONTHS_ID, formatDurationId, rowNetMinutes } = require('./overtime-input');

const MONEY_FMT = '"NT$"#,##0.00';
const centsToNum = (c) => Math.round(c) / 100;

function pad2(n) { return String(n).padStart(2, '0'); }

function headerRow(sheet, texts) {
  const row = sheet.addRow(texts);
  row.font = { bold: true };
  return row;
}

function setWidths(sheet, widths) {
  widths.forEach((w, i) => { sheet.getColumn(i + 1).width = w; });
}

/** Bangun workbook dari hasil agregasi + baris mentah satu bulan. */
async function buildPayrollWorkbook({ aggregate, rows, year, month, timezone }) {
  const t = aggregate.totals;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Lunifar Overtime Bot';
  const monthLabel = `${MONTHS_ID[month - 1]} ${year}`;

  // ---- Sheet 1: Ringkasan Bulanan ----
  const s1 = wb.addWorksheet('Ringkasan Bulanan');
  setWidths(s1, [30, 22]);
  s1.mergeCells('A1:B1');
  const title = s1.getCell('A1');
  title.value = `Rekap Lembur — ${monthLabel}`;
  title.font = { bold: true, size: 14 };
  const kv = [
    ['Bulan', monthLabel],
    ['Hari dengan lembur', t.dayCount],
    ['Total durasi', formatDurationId(t.minutes)],
    ['Total menit', t.minutes],
    ['Kategori 1 durasi (menit)', t.categories[1]],
    [`Kategori 1 upah (${RATE_TEXT[1]}/jam)`, centsToNum(t.catCents[1])],
    ['Kategori 2 durasi (menit)', t.categories[2]],
    [`Kategori 2 upah (${RATE_TEXT[2]}/jam)`, centsToNum(t.catCents[2])],
    ['Kategori 3 durasi (menit)', t.categories[3]],
    [`Kategori 3 upah (${RATE_TEXT[3]}/jam)`, centsToNum(t.catCents[3])],
    ['Total upah lembur (NT$)', centsToNum(t.totalCents)],
  ];
  for (const [k, v] of kv) {
    const r = s1.addRow([k, v]);
    r.getCell(1).font = { bold: true };
    if (typeof v === 'number' && k.includes('upah')) r.getCell(2).numFmt = MONEY_FMT;
  }
  s1.addRow([]);
  s1.addRow(['Tarif per jam', 'K1 NT$163,48 | K2 NT$203,74 | K3 NT$325,74']);

  // ---- Sheet 2: Rincian Lembur (per periode) ----
  const s2 = wb.addWorksheet('Rincian Lembur');
  const head2 = ['Tanggal', 'Mulai', 'Selesai', 'Durasi', 'Menit', 'Istirahat (menit)', 'Status',
    `K1 menit (upah @${RATE_TEXT[1]}/jam)`, `Upah K1`,
    `K2 menit (upah @${RATE_TEXT[2]}/jam)`, 'Upah K2',
    `K3 menit (upah @${RATE_TEXT[3]}/jam)`, 'Upah K3', 'Upah periode'];
  headerRow(s2, head2);
  setWidths(s2, [12, 9, 9, 14, 8, 14, 12, 12, 12, 12, 12, 12, 12, 14]);

  // ---- Sheet 3: Rekap Harian ----
  const s3 = wb.addWorksheet('Rekap Harian');
  headerRow(s3, ['Tanggal', 'Jumlah periode', 'Total durasi', 'Total menit',
    'K1 menit', 'Upah K1', 'K2 menit', 'Upah K2', 'K3 menit', 'Upah K3', 'Total upah']);
  setWidths(s3, [12, 14, 14, 11, 10, 12, 10, 12, 10, 12, 14]);

  // Kelompokkan baris per tanggal lokal (atribusi = tanggal mulai lokal).
  const byDay = new Map();
  for (const r of rows) {
    if (!r.end_at || r.status === 'active' || r.status === 'rejected') continue;
    const key = localDateKey(new Date(r.start_at), timezone);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }
  for (const d of aggregate.days) {
    const list = (byDay.get(d.key) || [])
      .map((r) => ({ r, ...rowNetMinutes(r) }))
      .filter((x) => x.net > 0)
      .sort((a, b) => new Date(a.r.start_at) - new Date(b.r.start_at));
    const allocs = allocatePeriods(list.map((x) => ({ minutes: x.net })));
    list.forEach((x, i) => {
      const a = allocs[i];
      const ps = toZonedParts(new Date(x.r.start_at), timezone);
      const pe = toZonedParts(new Date(x.r.end_at), timezone);
      const k = d.key;
      const row = s2.addRow([
        `${k.slice(8, 10)}-${k.slice(5, 7)}-${k.slice(0, 4)}`,
        `${pad2(ps.h)}:${pad2(ps.mi)}`,
        `${pad2(pe.h)}:${pad2(pe.mi)}`,
        formatDurationId(a.minutes),
        a.minutes,
        x.breakMinutes,
        x.r.status,
        a.categories[1], centsToNum(a.centsByCat[1]),
        a.categories[2], centsToNum(a.centsByCat[2]),
        a.categories[3], centsToNum(a.centsByCat[3]),
        centsToNum(a.totalCents),
      ]);
      [9, 11, 13, 14].forEach((c) => { row.getCell(c).numFmt = MONEY_FMT; });
    });
    const p = d.pay.categories;
    const row3 = s3.addRow([
      `${d.key.slice(8, 10)}-${d.key.slice(5, 7)}-${d.key.slice(0, 4)}`,
      list.length, formatDurationId(d.totalMinutes), d.totalMinutes,
      p[1].minutes, centsToNum(p[1].cents),
      p[2].minutes, centsToNum(p[2].cents),
      p[3].minutes, centsToNum(p[3].cents),
      centsToNum(d.pay.totalCents),
    ]);
    [6, 8, 10, 11].forEach((c) => { row3.getCell(c).numFmt = MONEY_FMT; });
  }
  if (s2.rowCount > 1) s2.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head2.length } };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Nama file aman untuk Telegram: hanya huruf/angka/minus/titik. */
function exportFileName(year, month) {
  return `lembur_${year}-${pad2(month)}.xlsx`;
}

module.exports = { buildPayrollWorkbook, exportFileName, MONEY_FMT };
