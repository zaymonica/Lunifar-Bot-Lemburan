'use strict';
const { ValidationError, ConflictError, AuthError, NotFoundError } = require('../utils/errors');
const i18n = require('../i18n');

const MAX_NAME_LEN = 120;
const MAX_DEPT_LEN = 80;
const MAX_EMPNUM_LEN = 40;

function sanitizeText(value, maxLen, label, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${label} wajib diisi.`);
    return null;
  }
  const s = String(value).trim().replace(/\s+/g, ' ');
  if (required && !s) throw new ValidationError(`${label} wajib diisi.`);
  if (s.length > maxLen) throw new ValidationError(`${label} maksimal ${maxLen} karakter.`);
  return s || null;
}

class EmployeeService {
  constructor({ employeeRepo, auditRepo, notificationService }) {
    this.employeeRepo = employeeRepo;
    this.auditRepo = auditRepo;
    this.notificationService = notificationService;
  }

  async getOrCreate(telegramUserId) {
    const id = Number(telegramUserId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('Telegram user ID tidak valid.');
    return this.employeeRepo.findByTelegramId(id);
  }

  async register({ telegramUserId, fullName, employeeNumber, department }) {
    const id = Number(telegramUserId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('Telegram user ID tidak valid.');
    const name = sanitizeText(fullName, MAX_NAME_LEN, 'Nama lengkap');
    const dept = sanitizeText(department, MAX_DEPT_LEN, 'Departemen');
    const empNum = sanitizeText(employeeNumber, MAX_EMPNUM_LEN, 'Nomor identitas karyawan', { required: false });

    const existing = await this.employeeRepo.findByTelegramId(id);
    if (existing && existing.status === 'active' && existing.is_active) {
      throw new ConflictError('Anda sudah terdaftar.');
    }
    if (existing) {
      // Bot pribadi: reaktivasi langsung untuk pending/rejected/inactive.
      await this.employeeRepo.setStatus(existing.id, 'active', true);
      await this.auditRepo.log(id, 'employee.register', 'employee', existing.id, `nama=${name} (reaktivasi)`);
      return { employeeId: existing.id, status: 'active' };
    }
    const employeeId = await this.employeeRepo.create({
      telegramUserId: id, fullName: name, employeeNumber: empNum, department: dept,
    });
    await this.auditRepo.log(id, 'employee.register', 'employee', employeeId, `nama=${name}`);
    return { employeeId, status: 'active' };
  }

  /** Memastikan user boleh mencatat lembur. */
  async requireActiveEmployee(telegramUserId) {
    const emp = await this.getOrCreate(telegramUserId);
    if (!emp) throw new NotFoundError('Anda belum terdaftar. Gunakan /start untuk mendaftar.');
    if (emp.status === 'pending') {
      // Bot pribadi: aktivasi otomatis untuk data lama yang masih pending.
      await this.employeeRepo.setStatus(emp.id, 'active', true);
      emp.status = 'active';
      emp.is_active = 1;
      return emp;
    }
    if (emp.status === 'rejected') throw new AuthError('Registrasi Anda ditolak sebelumnya. Daftar ulang dengan /daftar.');
    if (emp.status === 'inactive' || !emp.is_active) throw new AuthError('Akun Anda tidak aktif.');
    return emp;
  }

  /** Ambil bahasa pengguna (default 'id' bila belum memilih / nilai tak dikenal). */
  getLanguage(employee) {
    return i18n.normalizeLang(employee && employee.language);
  }

  /** Simpan preferensi bahasa per Telegram user. Melempar ValidationError untuk bahasa tak dikenal. */
  async setLanguage(telegramUserId, language) {
    const id = Number(telegramUserId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new ValidationError('Telegram user ID tidak valid.');
    const lang = i18n.normalizeLang(language);
    if (lang !== String(language || '').trim()) throw new ValidationError(i18n.t('id', 'language.invalid'));
    const emp = await this.employeeRepo.findByTelegramId(id);
    if (!emp) throw new NotFoundError('Anda belum terdaftar. Gunakan /start untuk mendaftar.');
    await this.employeeRepo.setLanguage(emp.id, lang);
    return lang;
  }

  async isAdmin(telegramUserId, envAdminIds) {
    const id = Number(telegramUserId);
    if (envAdminIds.includes(id)) return true;
    const emp = await this.employeeRepo.findByTelegramId(id);
    return !!(emp && emp.role === 'admin' && emp.status === 'active' && emp.is_active);
  }

  async decideRegistration(adminTelegramId, employeeId, approve, note) {
    const target = await this.employeeRepo.findById(Number(employeeId));
    if (!target) throw new NotFoundError('Karyawan tidak ditemukan.');
    if (target.status !== 'pending') throw new ConflictError('Registrasi ini sudah diproses.');
    const status = approve ? 'active' : 'rejected';
    await this.employeeRepo.setStatus(target.id, status, approve);
    await this.auditRepo.log(adminTelegramId, approve ? 'employee.approve' : 'employee.reject', 'employee', target.id, note || '');
    return target;
  }

  async setActive(adminTelegramId, employeeId, active) {
    const target = await this.employeeRepo.findById(Number(employeeId));
    if (!target) throw new NotFoundError('Karyawan tidak ditemukan.');
    await this.employeeRepo.setStatus(target.id, active ? 'active' : 'inactive', active);
    await this.auditRepo.log(adminTelegramId, active ? 'employee.activate' : 'employee.deactivate', 'employee', target.id, '');
    return target;
  }
}

module.exports = { EmployeeService, sanitizeText };
