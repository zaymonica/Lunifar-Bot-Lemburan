'use strict';

/**
 * Enkripsi simetris untuk pengaturan sensitif (token Telegram) di DB.
 * AES-256-GCM; kunci dari env WEB_SETTINGS_KEY (hex 64 char atau panjang bebas
 * → diturunkan dengan scrypt). Kunci TIDAK punya default di source code:
 * tanpa env, operasi token dinonaktifkan (fail-closed).
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function deriveKey(secret) {
  if (typeof secret !== 'string' || secret.trim().length < 16) {
    const err = new Error(
      'WEB_SETTINGS_KEY wajib diisi (min 16 karakter, disarankan 64 hex dari `openssl rand -hex 32`) ' +
      'untuk fitur pengaturan token Telegram.'
    );
    err.code = 'WEB_ENV_VALIDATION';
    throw err;
  }
  const trimmed = secret.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex');
  return crypto.scryptSync(trimmed, 'lunifar-web-settings', 32);
}

/** return: "v1.<iv-b64>.<tag-b64>.<data-b64>" */
function encryptText(plaintext, keyMaterial) {
  const key = deriveKey(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

/** Melempar jika ciphertext rusak/kunci salah — pemanggil menampilkan error generik. */
function decryptText(payload, keyMaterial) {
  const key = deriveKey(keyMaterial);
  const parts = String(payload || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    const err = new Error('Format ciphertext tidak dikenal.');
    err.code = 'CIPHER_FORMAT';
    throw err;
  }
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

/** Mask untuk ditampilkan ke browser: semuanya '*', kecuali 4 karakter terakhir. */
function maskToken(token) {
  const t = String(token || '');
  if (t.length <= 4) return '*'.repeat(t.length);
  return '*'.repeat(t.length - 4) + t.slice(-4);
}

module.exports = { encryptText, decryptText, maskToken, deriveKey };
