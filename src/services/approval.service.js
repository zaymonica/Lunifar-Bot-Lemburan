'use strict';
const { AuthError, ConflictError, NotFoundError, ValidationError } = require('../utils/errors');
const { durationMinutes, payableMinutes } = require('../utils/duration');
const i18n = require('../i18n');

/**
 * Alur status overtime_sessions:
 *   active  -> (selesai)  -> pending
 *   pending -> approved | rejected  (keputusan final, sekali saja)
 * Tidak ada jalur kembali; perubahan status dicatat di audit_logs.
 */
const FINAL_STATUSES = ['approved', 'rejected', 'completed'];

class ApprovalService {
  constructor({ overtimeRepo, approvalRepo, auditRepo, notificationService, config }) {
    this.overtimeRepo = overtimeRepo;
    this.approvalRepo = approvalRepo;
    this.auditRepo = auditRepo;
    this.notificationService = notificationService;
    this.config = config;
  }

  async decide({ approver, sessionId, approve, note, envAdminIds }) {
    // approver: row employees milik yang menekan tombol
    const session = await this.overtimeRepo.findById(Number(sessionId));
    if (!session) throw new NotFoundError('Sesi lembur tidak ditemukan.');
    if (FINAL_STATUSES.includes(session.status)) {
      throw new ConflictError(`Keputusan sudah dibuat sebelumnya (status: ${session.status}).`);
    }
    if (session.status !== 'pending') {
      throw new ConflictError('Hanya sesi berstatus pending yang dapat diputuskan.');
    }
    // Cegah self-approval
    if (session.employee_id === approver.id) {
      throw new AuthError('Anda tidak dapat menyetujui lembur Anda sendiri.');
    }
    // Hak akses: admin env, atau employee role admin/supervisor aktif
    const isEnvAdmin = envAdminIds.includes(Number(approver.telegram_user_id));
    const hasRole = ['admin', 'supervisor'].includes(approver.role) && approver.status === 'active' && approver.is_active;
    if (!isEnvAdmin && !hasRole) throw new AuthError('Hanya admin/atasan yang dapat menyetujui lembur.');

    const status = approve ? 'approved' : 'rejected';
    let actualMinutes = null;
    let pay = null;
    if (approve) {
      actualMinutes = durationMinutes(new Date(session.start_at), new Date(session.end_at));
      pay = payableMinutes(actualMinutes, this.config.overtime);
    }
    const ok = await this.overtimeRepo.setDecision(session.id, status, approver.id, note, actualMinutes, pay);
    if (!ok) throw new ConflictError('Sesi sudah diproses oleh admin lain.');
    await this.approvalRepo.record(session.id, approver.id, status, note);
    await this.auditRepo.log(approver.telegram_user_id, approve ? 'overtime.approve' : 'overtime.reject', 'overtime_session', session.id, note || '');
    // Notifikasi ke karyawan dalam bahasa penerima — kegagalan tidak membatalkan transaksi
    const durationText = actualMinutes === null || actualMinutes === undefined ? '-' : String(actualMinutes);
    const notify = this.notificationService.sendToLocalized
      ? this.notificationService.sendToLocalized.bind(this.notificationService)
      : (empId, build) => this.notificationService.sendTo(empId, build(i18n.t.bind(null, 'id')));
    notify(session.employee_id, (t) => [
      t(approve ? 'approval.approved' : 'approval.rejected'),
      t('approval.duration', { value: durationText }),
      t('approval.note', { value: note || '-' }),
      t('approval.by', { value: approver.full_name }),
    ].join('\n')).catch(() => {});
    return { session, status, actualMinutes, payableMinutes: pay };
  }

  async listPending(limit = 20) {
    return this.overtimeRepo.search({ status: 'pending', limit: Math.min(limit, 50) });
  }
}

module.exports = { ApprovalService, FINAL_STATUSES };
