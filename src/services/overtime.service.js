'use strict';
const { ValidationError, ConflictError, AuthError, NotFoundError } = require('../utils/errors');
const { durationMinutes, payableMinutes, formatDuration } = require('../utils/duration');
const { formatInTz, zonedWallToUtc } = require('../utils/date-time');
const {
  resolvePeriod, periodsOverlap, formatDailyRecap,
} = require('./overtime-input');
const { aggregateMonthly, formatMonthlyText } = require('./payroll');
const { buildPayrollWorkbook, exportFileName } = require('./payroll-excel');

class OvertimeService {
  constructor({ overtimeRepo, auditRepo, notificationService, config }) {
    this.overtimeRepo = overtimeRepo;
    this.auditRepo = auditRepo;
    this.notificationService = notificationService;
    this.config = config;
  }

  async startSession(employee, note) {
    if (note) {
      const n = String(note).trim();
      if (n.length > 500) throw new ValidationError('Catatan lembur maksimal 500 karakter.');
      note = n;
    }
    // Race condition dicegah oleh unique index (employee_id, active_flag) di DB.
    let sessionId;
    try {
      sessionId = await this.overtimeRepo.createActive(employee.id, note);
    } catch (err) {
      if (err && err.code === 'ER_DUP_ENTRY') {
        throw new ConflictError('Anda masih memiliki sesi lembur aktif. Selesaikan dulu dengan "Selesai Lembur".');
      }
      throw err;
    }
    await this.auditRepo.log(employee.telegram_user_id, 'overtime.start', 'overtime_session', sessionId, '');
    return this.overtimeRepo.findById(sessionId);
  }

  async finishSession(employee) {
    const active = await this.overtimeRepo.findActiveByEmployee(employee.id);
    if (!active) throw new NotFoundError('Tidak ada sesi lembur aktif. Mulai lembur dulu.');
    const ok = await this.overtimeRepo.finishActive(active.id);
    if (!ok) throw new ConflictError('Sesi sudah diselesaikan sebelumnya.');
    const updated = await this.overtimeRepo.findById(active.id);
    const minutes = durationMinutes(new Date(active.start_at), new Date(updated.end_at));
    const pay = payableMinutes(minutes, this.config.overtime);
    await this.auditRepo.log(employee.telegram_user_id, 'overtime.finish', 'overtime_session', active.id, `${minutes} menit`);
    return { session: updated, actualMinutes: minutes, payableMinutes: pay };
  }

  async myStatus(employee, timezone) {
    const active = await this.overtimeRepo.findActiveByEmployee(employee.id);
    const recent = await this.overtimeRepo.listByEmployee(employee.id, { limit: 5 });
    let running = null;
    if (active) {
      running = {
        since: formatInTz(new Date(active.start_at), timezone),
        elapsedMinutes: durationMinutes(new Date(active.start_at), new Date()),
      };
    }
    return { running, recent };
  }

  formatSummary(session, actualMinutes, payable, timezone) {
    const lines = [
      `📅 Mulai : ${formatInTz(new Date(session.start_at), timezone)}`,
      `🏁 Selesai: ${formatInTz(new Date(session.end_at), timezone)}`,
      `⏱️ Durasi aktual: ${formatDuration(actualMinutes)}`,
    ];
    lines.push(pay === null
      ? `⚠️ Di bawah minimum ${this.config.overtime.minMinutes} menit — tidak dihitung untuk laporan.`
      : `✅ Durasi terhitung: ${formatDuration(pay)}`);
    lines.push('Status: tercatat.');
    return lines.join('\n');
  }

  /**
   * Simpan satu periode lembur manual (multi-periode per tanggal diizinkan).
   * Mengembalikan { needsConfirm, overlapping, period } bila ada tumpang tindih
   * dan force=false — pemanggil WAJIB konfirmasi pengguna sebelum force=true.
   * Duplikat identik (karyawan + mulai + selesai sama) selalu ditolak.
   */
  async createManualPeriod(employee, input, { force = false } = {}) {
    const tz = this.config.timezone;
    const { startUtc, endUtc, minutes } = resolvePeriod(
      input.date, input.start, input.end, { crossMidnight: !!input.crossMidnight, timezone: tz }
    );
    // Istirahat eksplisit dalam menit (default 0 — TIDAK pernah dipotong otomatis,
    // apa pun hari dalam seminggu / tanggal merah).
    const breakMinutes = Number.isInteger(input.breakMinutes) && input.breakMinutes > 0
      ? input.breakMinutes : 0;
    if (breakMinutes >= minutes) {
      throw new ValidationError('Durasi istirahat harus kurang dari durasi kotor lembur (durasi bersih tidak boleh 0 atau negatif).');
    }
    const netMinutes = minutes - breakMinutes;
    const pay = payableMinutes(netMinutes, this.config.overtime);
    const dayStart = zonedWallToUtc(input.date.y, input.date.m, input.date.d, 0, 0, tz);
    const windowStart = new Date(dayStart.getTime() - 12 * 3600 * 1000);
    const windowEnd = new Date(dayStart.getTime() + 36 * 3600 * 1000);
    const existing = await this.overtimeRepo.listByEmployeeAndWindow(employee.id, windowStart, windowEnd);

    const duplicate = existing.find((r) => r.end_at
      && new Date(r.start_at).getTime() === startUtc.getTime()
      && new Date(r.end_at).getTime() === endUtc.getTime()
      && r.status !== 'rejected');
    if (duplicate) {
      throw new ConflictError('Periode lembur yang identik (mulai & selesai sama) sudah tercatat untuk tanggal ini.');
    }

    const overlapping = existing.filter((r) => r.status !== 'rejected' && r.end_at
      && periodsOverlap(new Date(r.start_at), new Date(r.end_at), startUtc, endUtc));
    if (overlapping.length && !force) {
      return { needsConfirm: true, overlapping, period: { startUtc, endUtc, minutes, netMinutes, breakMinutes, pay } };
    }

    const note = `input manual ${String(input.date.d).padStart(2, '0')}-${String(input.date.m).padStart(2, '0')}-${input.date.y}`;
    const sessionId = await this.overtimeRepo.withTransaction(async (conn) => {
      const id = await this.overtimeRepo.createManual(employee.id, startUtc, endUtc, netMinutes, pay, note, conn, breakMinutes);
      await this.auditRepo.log(employee.telegram_user_id, 'overtime.manual_input', 'overtime_session', id, `bersih ${netMinutes} menit (kotor ${minutes}, istirahat ${breakMinutes}) ${note}`, conn);
      return id;
    });

    const relevant = existing.filter((r) => r.status !== 'rejected' && r.end_at);
    const dayTotalMinutes = netMinutes + relevant.reduce((sum, r) => {
      const s = new Date(r.start_at); const e = new Date(r.end_at);
      const lo = Math.max(s.getTime(), dayStart.getTime());
      const hi = Math.min(e.getTime(), dayStart.getTime() + 86400000);
      if (hi <= lo) return sum;
      const overlapMin = Math.round((hi - lo) / 60000);
      const brk = Number(r.break_minutes);
      const b = Number.isFinite(brk) && brk > 0 ? Math.round(brk) : 0;
      // Istirahat dikurangi SEKALI, proporsional terhadap irisan hari (maks. seluruh istirahat).
      return sum + Math.max(0, overlapMin - Math.min(b, overlapMin));
    }, 0);
    return { needsConfirm: false, session: await this.overtimeRepo.findById(sessionId), actualMinutes: netMinutes, grossMinutes: minutes, breakMinutes, payableMinutes: pay, dayTotalMinutes, overlapping };
  }

  /** Status catatan yang boleh diedit lewat fitur Edit Lembur. */
  static get EDITABLE_STATUSES() { return ['completed', 'pending']; }

  /**
   * Edit catatan lembur milik karyawan (tanggal, jam mulai/selesai, istirahat).
   * Durasi SELALU dihitung ulang dari tanggal+jam (tidak pernah diedit manual);
   * durasi bersih = kotor − break_minutes; actual/payable disimpan dari bersih.
   * Kepemilikan & status diverifikasi ulang DI DALAM transaksi saat menyimpan.
   * Duplikat identik (dengan catatan LAIN) selalu ditolak; tumpang tindih
   * memerlukan force=true (sama seperti input manual).
   */
  async updateManualPeriod(employee, sessionId, input, { force = false } = {}) {
    const tz = this.config.timezone;
    const idNum = Number(sessionId);
    if (!Number.isInteger(idNum) || idNum <= 0) throw new ValidationError('ID catatan tidak valid.');

    const row = await this.overtimeRepo.findById(idNum);
    if (!row) throw new NotFoundError('Catatan lembur tidak ditemukan.');
    if (row.employee_id !== employee.id) {
      throw new AuthError('Anda hanya dapat mengedit catatan lembur milik Anda sendiri.');
    }
    if (!OvertimeService.EDITABLE_STATUSES.includes(row.status)) {
      throw new ConflictError(`Catatan dengan status "${row.status}" tidak dapat diedit.`);
    }

    const period = resolvePeriod(
      input.date, input.start, input.end, { crossMidnight: !!input.crossMidnight, timezone: tz }
    );
    const breakMinutes = Number.isInteger(input.breakMinutes) && input.breakMinutes > 0
      ? input.breakMinutes : 0;
    if (breakMinutes >= period.minutes) {
      throw new ValidationError('Durasi istirahat harus kurang dari durasi kotor lembur (durasi bersih tidak boleh 0 atau negatif).');
    }
    const netMinutes = period.minutes - breakMinutes;
    const pay = payableMinutes(netMinutes, this.config.overtime);

    const dayStart = zonedWallToUtc(input.date.y, input.date.m, input.date.d, 0, 0, tz);
    const existing = await this.overtimeRepo.listByEmployeeAndWindow(
      employee.id,
      new Date(dayStart.getTime() - 12 * 3600 * 1000),
      new Date(dayStart.getTime() + 36 * 3600 * 1000)
    );
    // Duplikat identik dengan catatan LAIN (diri sendiri dikecualikan).
    const duplicate = existing.find((r) => r.id !== idNum && r.end_at
      && new Date(r.start_at).getTime() === period.startUtc.getTime()
      && new Date(r.end_at).getTime() === period.endUtc.getTime()
      && r.status !== 'rejected');
    if (duplicate) {
      throw new ConflictError('Periode lembur yang identik (mulai & selesai sama) sudah tercatat untuk tanggal ini.');
    }
    const overlapping = existing.filter((r) => r.id !== idNum && r.status !== 'rejected' && r.end_at
      && periodsOverlap(new Date(r.start_at), new Date(r.end_at), period.startUtc, period.endUtc));
    if (overlapping.length && !force) {
      return { needsConfirm: true, overlapping, period: { startUtc: period.startUtc, endUtc: period.endUtc, minutes: period.minutes, netMinutes, breakMinutes, pay } };
    }

    const before = {
      start_at: row.start_at, end_at: row.end_at,
      break_minutes: Number(row.break_minutes) || 0,
      actual_minutes: row.actual_minutes, payable_minutes: row.payable_minutes,
      status: row.status,
    };
    const after = {
      start_at: period.startUtc, end_at: period.endUtc,
      break_minutes: breakMinutes, actual_minutes: netMinutes, payable_minutes: pay,
    };

    await this.overtimeRepo.withTransaction(async (conn) => {
      // Verifikasi ulang kepemilikan & status SAAT MENYIMPAN (bukan hanya saat tombol ditampilkan).
      const cur = await this.overtimeRepo.findById(idNum, conn);
      if (!cur || cur.employee_id !== employee.id) {
        throw new AuthError('Catatan tidak ditemukan atau bukan milik Anda.');
      }
      if (!OvertimeService.EDITABLE_STATUSES.includes(cur.status)) {
        throw new ConflictError(`Status catatan berubah menjadi "${cur.status}" sebelum disimpan — edit dibatalkan.`);
      }
      await this.overtimeRepo.updateManual(idNum, period.startUtc, period.endUtc, netMinutes, pay, breakMinutes, conn);
      // Audit: identitas, ID catatan, nilai sebelum/sesudah. Tanpa token/kredensial.
      await this.auditRepo.log(
        employee.telegram_user_id, 'overtime.edit', 'overtime_session', idNum,
        `sebelum=${JSON.stringify(before)} sesudah=${JSON.stringify(after)}`, conn
      );
    });

    const relevant = existing.filter((r) => r.id !== idNum && r.status !== 'rejected' && r.end_at);
    const dayTotalMinutes = netMinutes + relevant.reduce((sum, r) => {
      const s = new Date(r.start_at); const e = new Date(r.end_at);
      const lo = Math.max(s.getTime(), dayStart.getTime());
      const hi = Math.min(e.getTime(), dayStart.getTime() + 86400000);
      if (hi <= lo) return sum;
      const overlapMin = Math.round((hi - lo) / 60000);
      const brk = Number(r.break_minutes);
      const b = Number.isFinite(brk) && brk > 0 ? Math.round(brk) : 0;
      return sum + Math.max(0, overlapMin - Math.min(b, overlapMin));
    }, 0);

    return {
      session: await this.overtimeRepo.findById(idNum),
      grossMinutes: period.minutes, breakMinutes, actualMinutes: netMinutes,
      payableMinutes: pay, dayTotalMinutes, overlapping,
      before, after,
    };
  }

  /** Rekap satu tanggal lokal (objek {y,m,d}) untuk karyawan. */
  async getDailyRecap(employee, date, timezone) {
    const tz = timezone || this.config.timezone;
    const dayStart = zonedWallToUtc(date.y, date.m, date.d, 0, 0, tz);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const rows = await this.overtimeRepo.listByEmployeeAndWindow(employee.id, dayStart, dayEnd);
    const inDay = rows.filter((r) => new Date(r.start_at) < dayEnd && new Date(r.start_at) >= dayStart);
    return { rows: inDay, text: formatDailyRecap(inDay, tz) };
  }

  /**
   * Akumulasi bulanan jam & estimasi upah (TWD) untuk karyawan.
   * Kategori dihitung per tanggal lokal (determinasi zona waktu aplikasi).
   * Baris diambil dari window bulan lalu difilter start_at dalam bulan agar
   * periode lintas bulan tidak terhitung ganda (atribusi = tanggal mulai lokal).
   */
  async fetchMonthRows(employee, year, month) {
    const tz = this.config.timezone;
    const windowStart = zonedWallToUtc(year, month, 1, 0, 0, tz);
    const ny = month === 12 ? year + 1 : year;
    const nm = month === 12 ? 1 : month + 1;
    const windowEnd = zonedWallToUtc(ny, nm, 1, 0, 0, tz);
    const rows = await this.overtimeRepo.listByEmployeeAndWindow(employee.id, windowStart, windowEnd);
    const inMonth = rows.filter((r) => {
      const s = new Date(r.start_at);
      return s >= windowStart && s < windowEnd;
    });
    return { inMonth };
  }

  async getMonthlyPayroll(employee, year, month) {
    const { inMonth } = await this.fetchMonthRows(employee, year, month);
    const aggregate = aggregateMonthly(inMonth, this.config.timezone);
    return { aggregate, text: formatMonthlyText(aggregate, year, month) };
  }

  /**
   * Ekspor Excel rekap bulanan. Sumber data, filter status, atribusi tanggal,
   * dan perhitungan upah SAMA dengan getMonthlyPayroll (read-only).
   */
  async exportMonthlyPayroll(employee, year, month) {
    const { inMonth } = await this.fetchMonthRows(employee, year, month);
    const aggregate = aggregateMonthly(inMonth, this.config.timezone);
    const buffer = await buildPayrollWorkbook({
      aggregate, rows: inMonth, year, month, timezone: this.config.timezone,
    });
    return { buffer, filename: exportFileName(year, month), aggregate };
  }
}

module.exports = { OvertimeService };
