'use strict';

const MS_MIN = 60 * 1000;

/** Durasi dalam menit antara dua Date. Melempar Error jika tidak valid. */
function durationMinutes(startAt, endAt) {
  if (!(startAt instanceof Date) || !(endAt instanceof Date) ||
      Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw new Error('Timestamp tidak valid');
  }
  const diff = Math.round((endAt.getTime() - startAt.getTime()) / MS_MIN);
  if (diff < 0) throw new Error('Durasi negatif: endAt sebelum startAt');
  return diff;
}

/** Pembulatan ke atas kelipatan menit (untuk pelaporan; tidak mengubah timestamp asli). */
function roundUpMinutes(minutes, step) {
  if (!step || step <= 0) return minutes;
  return Math.ceil(minutes / step) * step;
}

/** Menit dapat dihitung sesuai kebijakan: pembulatan + batas minimum. Null jika di bawah minimum. */
function payableMinutes(minutes, { minMinutes = 30, roundingMinutes = 15 } = {}) {
  if (minutes < minMinutes) return null;
  return roundUpMinutes(minutes, roundingMinutes);
}

function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} jam ${m % 60} menit` : `${m} menit`;
}

module.exports = { durationMinutes, roundUpMinutes, payableMinutes, formatDuration };
