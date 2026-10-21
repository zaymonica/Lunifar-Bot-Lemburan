'use strict';

/**
 * Store pengaturan web (Tahap 3) di atas app_settings existing (SettingsRepo).
 * Token Telegram disimpan TERENKRIPSI (AES-256-GCM), kunci dari env
 * WEB_SETTINGS_KEY. Nilai token tidak pernah dikembalikan utuh ke API.
 */

const { encryptText, decryptText, deriveKey } = require('./crypto');

const KEY_TOKEN = 'web.bot_token_enc';

class WebSettingsStore {
  constructor({ settingsRepo, settingsKey = null }) {
    this.settingsRepo = settingsRepo;
    this.settingsKey = settingsKey; // env WEB_SETTINGS_KEY; null = fitur token nonaktif
  }

  /**
   * Resolusi kunci pengaturan dari env untuk startup:
   * - tidak diisi  → { key: null, warning: '...' } (fitur nonaktif, server tetap jalan)
   * - terlalu lemah → throw WEB_ENV_VALIDATION (fail fast, pesan jelas)
   * - valid        → { key, warning: null }
   * Tidak pernah mengembalikan/mencetak nilai kunci itu sendiri.
   */
  static resolveSettingsKey(rawKey) {
    if (typeof rawKey !== 'string' || !rawKey.trim()) {
      return {
        key: null,
        warning: 'WEB_SETTINGS_KEY tidak di-set — penyimpanan token bot via Web Admin DINONAKTIFKAN. ' +
          'Isi WEB_SETTINGS_KEY di .env (contoh: openssl rand -hex 32) lalu restart server.',
      };
    }
    // Validasi kekuatan kunci lebih awal (min 16 char) — gagal cepat di startup.
    deriveKey(rawKey);
    return { key: rawKey, warning: null };
  }

  get tokenEnabled() {
    return !!this.settingsKey;
  }

  /** Simpan token terenkripsi. Melempar jika WEB_SETTINGS_KEY belum diset. */
  async setBotToken(token) {
    if (!this.settingsKey) {
      const err = new Error('WEB_SETTINGS_KEY belum dikonfigurasi — penyimpanan token dinonaktifkan.');
      err.code = 'WEB_ENV_VALIDATION';
      throw err;
    }
    await this.settingsRepo.set(KEY_TOKEN, encryptText(token, this.settingsKey));
    return true;
  }

  /** Kembalikan token plaintext HANYA untuk proses server (lifecycle bot). */
  async getBotToken() {
    if (!this.settingsKey) return null;
    const enc = await this.settingsRepo.get(KEY_TOKEN);
    if (!enc) return null;
    return decryptText(enc, this.settingsKey);
  }

  /** Status untuk API: konfigurasi ada/tidak + mask, tanpa plaintext. */
  async getBotTokenStatus() {
    if (!this.settingsKey) return { enabled: false, configured: false, masked: null };
    const enc = await this.settingsRepo.get(KEY_TOKEN);
    if (!enc) return { enabled: true, configured: false, masked: null };
    try {
      const token = decryptText(enc, this.settingsKey);
      const { maskToken } = require('./crypto');
      return { enabled: true, configured: true, masked: maskToken(token) };
    } catch (e) {
      return { enabled: true, configured: false, masked: null, error: 'TOKEN_RUSAK' };
    }
  }

  async clearBotToken() {
    if (!this.settingsKey) return false;
    await this.settingsRepo.set(KEY_TOKEN, '');
    return true;
  }
}

module.exports = { WebSettingsStore, KEY_TOKEN };
