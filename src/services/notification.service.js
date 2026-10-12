'use strict';
const i18n = require('../i18n');

/**
 * Notifikasi Telegram. Prinsip:
 * - Kegagalan kirim TIDAK boleh melempar ke caller transaksi (fire-and-forget dengan catch).
 * - Rate limit 429 dihormati (retry setelah retry_after, maks 2 kali).
 * - Penerima di-resolve by employee_id agar tidak bocor data via ID Telegram pihak ketiga.
 */
class NotificationService {
  constructor({ bot, employeeRepo, logger }) {
    this.bot = bot;
    this.employeeRepo = employeeRepo;
    this.logger = logger;
    this.adminTelegramIds = [];
  }

  setAdminIds(ids) { this.adminTelegramIds = ids || []; }

  async sendTo(employeeId, text) {
    const emp = await this.employeeRepo.findById(Number(employeeId));
    if (!emp || emp.status !== 'active' || !emp.is_active) return;
    await this._send(emp.telegram_user_id, text);
  }

  /**
   * Kirim notifikasi yang teksnya dibangun dalam bahasa penerima.
   * `build` dipanggil dengan (t) yang sudah terikat bahasa karyawan.
   * Kegagalan lookup/kirim tetap fire-and-forget.
   */
  async sendToLocalized(employeeId, build) {
    const emp = await this.employeeRepo.findById(Number(employeeId)).catch(() => null);
    if (!emp || emp.status !== 'active' || !emp.is_active) return;
    const lang = i18n.normalizeLang(emp.language);
    const t = (key, params) => i18n.t(lang, key, params);
    const text = typeof build === 'function' ? build(t) : String(build);
    await this._send(emp.telegram_user_id, text);
  }

  async notifyAdmins(text, aboutEmployeeId = null) {
    const targets = new Set(this.adminTelegramIds);
    if (aboutEmployeeId) {
      // tidak mengirim balik ke karyawan yang bersangkutan jika ia admin
    }
    for (const id of targets) {
      await this._send(id, text);
    }
  }

  async _send(chatId, text, attempt = 0) {
    if (!this.bot) return;
    try {
      await this.bot.telegram.sendMessage(chatId, text);
    } catch (err) {
      if (err && err.response && err.response.error_code === 429 && attempt < 2) {
        const wait = (err.response.parameters && err.response.parameters.retry_after) || 3;
        setTimeout(() => {
          this._send(chatId, text, attempt + 1).catch((e) =>
            this.logger.warn('Notifikasi gagal (retry)', { chatId, error: e.message }));
        }, wait * 1000);
        return;
      }
      // Jangan lempar: kegagalan notifikasi tidak boleh membatalkan operasi utama
      this.logger.warn('Gagal mengirim notifikasi', { chatId, error: err.message });
    }
  }
}

module.exports = { NotificationService };
