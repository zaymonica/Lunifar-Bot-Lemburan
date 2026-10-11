'use strict';

/**
 * Waktu disimpan di database sebagai UTC (DATETIME UTC / CURRENT_TIMESTAMP pada kolom UTC).
 * Zona waktu hanya diterapkan di lapisan tampilan/laporan.
 */

function toZonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}:${parts.second}`,
    ymd: { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) },
  };
}

function formatInTz(date, timeZone, withTime = true) {
  const p = toZonedParts(date, timeZone);
  return withTime ? `${p.date} ${p.time}` : p.date;
}

/** Batas hari (00:00) pada timezone, dikembalikan sebagai Date UTC. */
function startOfDayInTz(dateLike, timeZone) {
  const target = toZonedParts(new Date(dateLike), timeZone).date;
  // Offset zona waktu: selisih antara jam dinding lokal dan UTC untuk instan referensi.
  const ref = new Date(`${target}T12:00:00Z`);
  const wallHour = Number(toZonedParts(ref, timeZone).time.slice(0, 2));
  const offsetMs = (wallHour - 12) * 3600 * 1000;
  return new Date(new Date(`${target}T00:00:00Z`).getTime() - offsetMs);
}

/**
 * Konversi waktu dinding lokal (zona waktu) menjadi instan UTC.
 * Menangani offset zona (termasuk yang bergeser) dengan iterasi.
 */
function zonedWallToUtc(y, m, d, hh, mm, timeZone) {
  const targetMs = Date.UTC(y, m - 1, d, hh, mm);
  // Offset zona dihitung dari instan referensi (jam target pada hari yang sama).
  const ref = new Date(targetMs);
  const wall = toZonedParts(ref, timeZone);
  const wallMs = Date.UTC(
    wall.ymd.y, wall.ymd.m - 1, wall.ymd.d,
    Number(wall.time.slice(0, 2)), Number(wall.time.slice(3, 5)), Number(wall.time.slice(6, 8))
  );
  const offset = targetMs - wallMs; // selisih UTC ↔ waktu dinding
  let ts = targetMs + offset;
  // Satu koreksi tambahan (jaga-jaga zona offset bervariasi/DST).
  const w2 = toZonedParts(new Date(ts), timeZone);
  const w2Ms = Date.UTC(
    w2.ymd.y, w2.ymd.m - 1, w2.ymd.d,
    Number(w2.time.slice(0, 2)), Number(w2.time.slice(3, 5)), Number(w2.time.slice(6, 8))
  );
  if (w2Ms !== targetMs) ts += targetMs - w2Ms;
  return new Date(ts);
}

module.exports = { toZonedParts, formatInTz, startOfDayInTz, zonedWallToUtc };
