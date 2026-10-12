'use strict';

/**
 * Parser & formatter murni untuk input lembur manual (multi-periode per tanggal).
 * Tidak menyentuh DB/Telegraf — mudah diuji.
 */
const { zonedWallToUtc } = require('../utils/date-time');
const { ValidationError } = require('../utils/errors');
const i18n = require('../i18n');

const MONTHS_ID = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** Parse tanggal DD-MM-YYYY ketat (kalender valid). */
function parseDateDDMMYYYY(input) {
  const s = String(input || '').trim();
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (!m) throw new ValidationError('Format tanggal harus DD-MM-YYYY, contoh: 01-10-2026.');
  const y = Number(m[1 + 2]);
  const mo = Number(m[2]);
  const d = Number(m[1]);
  if (y < 2000 || y > 2100) throw new ValidationError('Tahun di luar rentang wajar (2000-2100).');
  if (mo < 1 || mo > 12) throw new ValidationError('Bulan tidak valid.');
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw new ValidationError('Tanggal tidak valid untuk kalender (mis. 31-02).');
  }
  return { y, m: mo, d };
}

/** Parse jam HH:MM ketat (00:00-23:59). */
function parseTimeHHMM(input) {
  const s = String(input || '').trim();
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new ValidationError('Format jam harus HH:MM (00:00-23:59), contoh: 16:30.');
  return { h: Number(m[1]), min: Number(m[2]) };
}

/**
 * Gabungkan tanggal + jam mulai/selesai menjadi instan UTC.
 * Jika selesai < mulai tanpa konfirmasi lintas hari → error code CROSS_MIDNIGHT
 * (handler harus bertanya ke pengguna, bukan menebak).
 * Jika selesai == mulai → durasi nol, ditolak.
 */
function resolvePeriod(date, start, end, { crossMidnight = false, timezone } = {}) {
  // Validasi rentang jam/menit & tanggal kalender secara eksplisit.
  for (const t of [start, end]) {
    if (!t || !Number.isInteger(t.h) || t.h < 0 || t.h > 23
      || !Number.isInteger(t.min) || t.min < 0 || t.min > 59) {
      throw new ValidationError('Jam tidak valid — gunakan HH:MM (00:00-23:59).');
    }
  }
  if (!date || !Number.isInteger(date.y) || !Number.isInteger(date.m) || !Number.isInteger(date.d)
    || date.y < 2000 || date.y > 2100 || date.m < 1 || date.m > 12) {
    throw new ValidationError('Tanggal tidak valid.');
  }
  const cal = new Date(Date.UTC(date.y, date.m - 1, date.d));
  if (cal.getUTCMonth() !== date.m - 1 || cal.getUTCDate() !== date.d) {
    throw new ValidationError('Tanggal tidak valid untuk kalender (mis. 31-02).');
  }
  const startUtc = zonedWallToUtc(date.y, date.m, date.d, start.h, start.min, timezone);
  let ey = date.y, em = date.m, ed = date.d;
  if (crossMidnight) {
    const next = new Date(Date.UTC(date.y, date.m - 1, date.d + 1));
    ey = next.getUTCFullYear(); em = next.getUTCMonth() + 1; ed = next.getUTCDate();
  }
  const endUtc = zonedWallToUtc(ey, em, ed, end.h, end.min, timezone);
  const endMinutes = end.h * 60 + end.min;
  const startMinutes = start.h * 60 + start.min;
  if (endMinutes === startMinutes && !crossMidnight) {
    throw new ValidationError('Jam selesai sama dengan jam mulai — durasi tidak boleh 0 menit.');
  }
  if (endUtc <= startUtc) {
    if (!crossMidnight && endMinutes < startMinutes) {
      const err = new ValidationError('INTERNAL_MARKER');
      err.code = 'CROSS_MIDNIGHT';
      throw err;
    }
    throw new ValidationError('Durasi lembur tidak valid (selesai tidak boleh sebelum/sama dengan mulai).');
  }
  const minutes = Math.round((endUtc.getTime() - startUtc.getTime()) / 60000);
  return { startUtc, endUtc, minutes };
}

/** Dua interval [aS,aE) dan [bS,bE) tumpang tindih? */
function periodsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/** Durasi ramah bahasa: "2 jam", "1 jam 30 menit", "45 menit" (default 'id'). */
function formatDurationId(minutes, lang = 'id') {
  return i18n.formatDuration(minutes, lang);
}
const formatDurationLang = formatDurationId;

/**
 * Titik TUNGGAL pengurangan istirahat. Semua modul (rekap harian, payroll,
 * Excel, service) WAJIB memakai fungsi ini — tidak boleh mengurangi
 * break_minutes di tempat lain (mencegah pengurangan ganda).
 * Baris tanpa break_minutes (data historis) → net = gross, tidak diubah.
 */
function rowNetMinutes(row) {
  const gross = Math.round((new Date(row.end_at) - new Date(row.start_at)) / 60000);
  const b = Number(row.break_minutes);
  const breakMinutes = Number.isFinite(b) && b > 0 ? Math.round(b) : 0;
  return { gross, breakMinutes, net: gross - breakMinutes };
}

/**
 * Rekap harian: semua periode (kecuali aktif/ditolak, dengan catatan) berurutan
 * berdasarkan jam mulai, lalu total durasi harian (durasi BERSIH = kotor − istirahat).
 */
function formatDailyRecap(rows, timezone, labelOverride = null, lang = 'id') {
  const usable = rows.filter((r) => r.end_at && r.status !== 'active' && r.status !== 'rejected');
  const excluded = rows.length - usable.length;
  if (!usable.length) return null;
  const first = new Date(usable[0].start_at);
  const p0 = _parts(first, timezone);
  const label = labelOverride || i18n.formatDate(lang, { y: p0.y, m: p0.mo, d: p0.d });
  const sorted = [...usable].sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  let total = 0;
  const blocks = sorted.map((r, i) => {
    const s = new Date(r.start_at);
    const e = new Date(r.end_at);
    const ps = _parts(s, timezone);
    const pe = _parts(e, timezone);
    const { gross, breakMinutes, net } = rowNetMinutes(r);
    total += net;
    const statusTag = r.status === 'pending' ? i18n.t(lang, 'common.oldDataTag') : '';
    const lines = [
      i18n.t(lang, 'recap.period', { n: i + 1 }) + statusTag,
      i18n.t(lang, 'recap.start', { time: `${String(ps.h).padStart(2, '0')}:${String(ps.mi).padStart(2, '0')}` }),
      i18n.t(lang, 'recap.end', { time: `${String(pe.h).padStart(2, '0')}:${String(pe.mi).padStart(2, '0')}` }),
      i18n.t(lang, 'recap.duration', { duration: formatDurationId(net, lang) }),
    ];
    if (breakMinutes > 0) lines.push(i18n.t(lang, 'recap.brkDetail', { gross: formatDurationId(gross, lang), break: breakMinutes }));
    return lines.join('\n');
  });
  const parts = [
    i18n.t(lang, 'recap.dateLabel', { date: label }),
    '',
    blocks.join('\n\n'),
    '',
    i18n.t(lang, 'recap.total', { duration: formatDurationId(total, lang) }),
  ];
  if (excluded > 0) parts.push(i18n.t(lang, 'recap.excluded', { count: excluded }));
  return parts.join('\n');
}

function _parts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: p.hour === '24' ? 0 : Number(p.hour), mi: Number(p.minute) };
}

module.exports = {
  MONTHS_ID, parseDateDDMMYYYY, parseTimeHHMM, resolvePeriod,
  periodsOverlap, formatDurationId, formatDurationLang, formatDailyRecap, rowNetMinutes,
};