'use strict';

/**
 * Rate limiter login in-memory (per proses).
 * Kunci = ip + username (lowercase). Cukup untuk 1 instance; jika nanti
 * berjalan multi-instance, ganti dengan store bersama.
 */

class LoginRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
    this.windowMs = Math.max(1000, Number(windowMs) || 15 * 60 * 1000);
    this.attempts = new Map(); // key -> { count, windowStart }
    this.now = now;
    // Bersihkan entri kadaluarsa secara berkala tanpa menggagu proses.
    setInterval(() => this.sweep(), this.windowMs).unref();
  }

  key(ip, username) {
    return `${String(ip || 'unknown')}|${String(username || '').toLowerCase()}`;
  }

  /** Cek apakah percobaan berikutnya diizinkan. Tidak mengubah counter. */
  check(ip, username) {
    this.sweep();
    const k = this.key(ip, username);
    const entry = this.attempts.get(k);
    if (!entry) return { allowed: true, remaining: this.maxAttempts };
    const elapsed = this.now() - entry.windowStart;
    if (elapsed >= this.windowMs) return { allowed: true, remaining: this.maxAttempts };
    if (entry.count >= this.maxAttempts) {
      return { allowed: false, retryAfterMs: this.windowMs - elapsed };
    }
    return { allowed: true, remaining: this.maxAttempts - entry.count };
  }

  /** Catat satu percobaan (gagal). */
  recordFailure(ip, username) {
    const k = this.key(ip, username);
    const t = this.now();
    const entry = this.attempts.get(k);
    if (!entry || t - entry.windowStart >= this.windowMs) {
      this.attempts.set(k, { count: 1, windowStart: t });
      return;
    }
    entry.count += 1;
  }

  /** Hapus counter setelah login sukses. */
  reset(ip, username) {
    this.attempts.delete(this.key(ip, username));
  }

  sweep() {
    const t = this.now();
    for (const [k, entry] of this.attempts) {
      if (t - entry.windowStart >= this.windowMs) this.attempts.delete(k);
    }
  }
}

function makeLoginRateLimiter(options) {
  return new LoginRateLimiter(options);
}

module.exports = { LoginRateLimiter, makeLoginRateLimiter };
