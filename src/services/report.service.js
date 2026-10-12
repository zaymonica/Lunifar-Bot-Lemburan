'use strict';
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ValidationError, AuthError } = require('../utils/errors');
const i18n = require('../i18n');
const { formatInTz } = require('../utils/date-time');
const { formatDuration } = require('../utils/duration');

const VALID_STATUSES = ['pending', 'approved', 'rejected', 'completed', 'active'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_EXPORT_ROWS = 2000;

class ReportService {
  constructor({ overtimeRepo, employeeRepo, config, logger }) {
    this.overtimeRepo = overtimeRepo;
    this.employeeRepo = employeeRepo;
    this.config = config;
    this.logger = logger;
  }

  /** Validasi & normalisasi filter. Tanggal dianggap dalam APP_TIMEZONE, dikonversi ke UTC. */
  async buildFilters({ from, to, department, status, employeeNumber }) {
    const { startOfDayInTz } = require('../utils/date-time');
    const filters = { employeeId: null, department: null, status: null, fromUtc: null, toUtc: null };
    if (from) {
      if (!DATE_RE.test(from)) throw new ValidationError('Format tanggal dari: YYYY-MM-DD');
      filters.fromUtc = startOfDayInTz(`${from}T00:00:00Z`, this.config.timezone);
    }
    if (to) {
      if (!DATE_RE.test(to)) throw new ValidationError('Format tanggal sampai: YYYY-MM-DD');
      const toStart = startOfDayInTz(`${to}T00:00:00Z`, this.config.timezone);
      filters.toUtc = new Date(toStart.getTime() + 24 * 3600 * 1000); // eksklusif
    }
    if (from && to && filters.fromUtc >= filters.toUtc) {
      throw new ValidationError('Tanggal "dari" harus sebelum "sampai".');
    }
    if (status) {
      if (!VALID_STATUSES.includes(status)) throw new ValidationError('Status tidak valid.');
      filters.status = status;
    }
    if (department) {
      const d = String(department).trim().slice(0, 80);
      if (!d) throw new ValidationError('Departemen tidak valid.');
      filters.department = d;
    }
    if (employeeNumber) {
      const emp = await this.employeeRepo.list({ search: String(employeeNumber).trim(), limit: 1 });
      if (!emp.length) throw new ValidationError('Karyawan tidak ditemukan.');
      filters.employeeId = emp[0].id;
    }
    return filters;
  }

  /** Export Excel; mengembalikan path file sementara. Pemanggil wajib menghapus file setelah dikirim. */
  async exportExcel(filters, requestedBy, lang = 'id') {
    const rows = await this.overtimeRepo.search({ ...filters, limit: MAX_EXPORT_ROWS });
    if (rows.length === 0) throw new ValidationError('Tidak ada data untuk filter ini.');

    const tz = this.config.timezone;
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Lunifar Overtime Bot';
    const ws = wb.addWorksheet('Lembur');
    const h = (key) => i18n.t(lang, key);
    ws.columns = [
      { header: h('excel.headerName'), key: 'name', width: 28 },
      { header: h('excel.headerEmpNum'), key: 'empnum', width: 16 },
      { header: h('excel.headerDept'), key: 'dept', width: 20 },
      { header: h('excel.headerDate'), key: 'date', width: 12 },
      { header: h('excel.headerStart'), key: 'start', width: 10 },
      { header: h('excel.headerEnd'), key: 'end', width: 10 },
      { header: h('excel.headerActual'), key: 'actual', width: 20 },
      { header: h('excel.headerPayable'), key: 'payable', width: 24 },
      { header: h('excel.headerStatus'), key: 'status', width: 12 },
      { header: h('excel.headerApprover'), key: 'approver', width: 22 },
      { header: h('excel.headerNote'), key: 'note', width: 40 },
    ];
    ws.getRow(1).font = { bold: true };

    let totalActual = 0;
    let totalPayable = 0;
    for (const r of rows) {
      const actual = r.actual_minutes ?? (r.end_at ? Math.round((new Date(r.end_at) - new Date(r.start_at)) / 60000) : null);
      totalActual += actual || 0;
      totalPayable += r.payable_minutes || 0;
      ws.addRow({
        name: r.full_name,
        empnum: r.employee_number || '-',
        dept: r.department,
        date: formatInTz(new Date(r.start_at), tz, false),
        start: formatInTz(new Date(r.start_at), tz).slice(11, 16),
        end: r.end_at ? formatInTz(new Date(r.end_at), tz).slice(11, 16) : '-',
        actual: actual ?? '-',
        payable: r.payable_minutes ?? '-',
        status: r.status,
        approver: r.approver_name || '-',
        note: r.decision_note || r.note || '',
      });
    }

    const summary = ws.addRow({});
    const totalRow = ws.addRow([i18n.t(lang, 'excel.total'), '', '', '', '', '', totalActual, totalPayable || '-', '', '', '']);
    totalRow.font = { bold: true };
    ws.addRow([i18n.t(lang, 'excel.createdLine', {
      created: formatInTz(new Date(), tz), tz, requestedBy, rows: rows.length,
    })]).font = { italic: true, size: 9 };

    const tmpDir = path.join(os.tmpdir(), 'lunifar-ot-exports');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, `laporan-lembur-${Date.now()}-${Math.floor(Math.random() * 1e6)}.xlsx`);
    await wb.xlsx.writeFile(filePath);
    return { filePath, rowCount: rows.length, totalActual, totalPayable };
  }

  /** Ringkasan rekap per karyawan dalam rentang. */
  async recap(filters, lang = 'id') {
    const rows = await this.overtimeRepo.search({ ...filters, limit: MAX_EXPORT_ROWS });
    const tz = this.config.timezone;
    const perEmployee = new Map();
    for (const r of rows) {
      if (!['approved', 'completed'].includes(r.status)) continue;
      const key = r.employee_id;
      const cur = perEmployee.get(key) || { name: r.full_name, department: r.department, minutes: 0, sessions: 0 };
      cur.minutes += r.payable_minutes || 0;
      cur.sessions += 1;
      perEmployee.set(key, cur);
    }
    return {
      range: filters.fromUtc && filters.toUtc
        ? `${formatInTz(filters.fromUtc, tz, false)} - ${formatInTz(new Date(filters.toUtc.getTime() - 1), tz, false)}`
        : i18n.t(lang, 'report.allTime'),
      entries: [...perEmployee.values()].sort((a, b) => b.minutes - a.minutes),
      totalMinutes: [...perEmployee.values()].reduce((s, e) => s + e.minutes, 0),
    };
  }
}

module.exports = { ReportService, MAX_EXPORT_ROWS };
