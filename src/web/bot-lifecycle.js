'use strict';

/**
 * Lifecycle manager bot (Tahap 3).
 *
 * - State machine: stopped → starting → running → stopping → stopped, atau
 *   error (dengan detail pesan generik, tanpa token).
 * - Satu instance saja per proses; start saat starting/running ditolak.
 * - Token diambil dari settings DB (terenkripsi) atau env config.botToken.
 * - Bot TIDAK pernah di-start otomatis oleh web — hanya lewat start() eksplisit.
 * - deleteWebhook TIDAK dipanggil di sini (hindari menghapus pending updates).
 */

const { createBot } = require('../bot');
const { createLogger } = require('../utils/logger');

const STATES = ['stopped', 'starting', 'running', 'stopping', 'error'];

class BotLifecycle {
  constructor({ config, services, settingsStore, logger = null }) {
    this.config = config;
    this.services = services;
    this.settingsStore = settingsStore;
    this.logger = logger || createLogger(config.logLevel || 'info');
    this.state = 'stopped';
    this.lastError = null; // pesan error start terakhir; bukan state palsu
    this.startedAt = null;
    this.bot = null;
  }

  get status() {
    return {
      state: this.state,
      error: this.lastError,
      startedAt: this.startedAt,
      tokenConfigured: this.settingsStore ? undefined : !!this.config.botToken,
    };
  }

  _assertStateTransition(to) {
    if (!STATES.includes(to)) throw new Error(`State tidak dikenal: ${to}`);
  }

  async start() {
    // Tolak juga saat 'stopping': start paralel dengan stop bisa menghasilkan
    // dua instance polling (konflik getUpdates 409).
    if (this.state === 'running' || this.state === 'starting' || this.state === 'stopping') {
      const err = new Error('Bot sudah berjalan atau sedang dalam proses transisi.');
      err.code = 'BOT_STATE';
      throw err;
    }
    this.state = 'starting';
    this.lastError = null;
    try {
      let token = null;
      if (this.settingsStore) {
        token = await this.settingsStore.getBotToken(); // null jika belum disimpan/gagal dekripsi
      }
      token = token || this.config.botToken;
      if (!token) {
        throw new Error('Token bot belum dikonfigurasi (simpan di Pengaturan atau set BOT_TOKEN di env).');
      }
      const bot = createBot({
        config: { ...this.config, botToken: token },
        services: this.services,
        logger: this.logger,
      });
      this.bot = bot;
      // Long polling; TANPA deleteWebhook di sini — hanya bot-only startup (src/app.js)
      // yang mengelola webhook saat proses khusus bot.
      await bot.launch(() => {});
      this.state = 'running';
      this.startedAt = new Date().toISOString();
      this.logger.info('Bot di-start dari Web Admin.');
      return this.status;
    } catch (err) {
      // Tidak ada bot yang berjalan setelah gagal start — kembali ke 'stopped'
      // (bukan 'error' yang lengket/palsu) dan simpan pesan untuk UI.
      this.state = 'stopped';
      this.lastError = err.message;
      this.bot = null;
      this.startedAt = null;
      throw err;
    }
  }

  async stop() {
    if (this.state !== 'running') {
      const err = new Error('Bot tidak sedang berjalan.');
      err.code = 'BOT_STATE';
      throw err;
    }
    this.state = 'stopping';
    try {
      this.bot.stop('WEB_ADMIN_STOP');
      this.state = 'stopped';
      this.startedAt = null;
      this.logger.info('Bot di-stop dari Web Admin.');
      return this.status;
    } catch (err) {
      this.state = 'stopped';
      this.lastError = err.message;
      throw err;
    } finally {
      this.bot = null;
    }
  }

  async restart() {
    if (this.state === 'running') await this.stop();
    if (this.state === 'starting' || this.state === 'stopping') {
      const err = new Error('Bot sedang dalam transisi state.');
      err.code = 'BOT_STATE';
      throw err;
    }
    return this.start();
  }
}

module.exports = { BotLifecycle, STATES };
