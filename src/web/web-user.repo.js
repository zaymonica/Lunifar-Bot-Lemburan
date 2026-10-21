'use strict';

/**
 * Repositori web_users (Tahap 2). Prepared statements; kolom password_hash
 * tidak pernah keluar dari layer server — adapter di bawah hanya meneruskan
 * hash ke bcrypt.compare di routes/auth.
 */

class WebUserRepository {
  constructor(pool) {
    this.pool = pool;
  }

  /** username TELAH dinormalisasi lowercase oleh pemanggil. */
  async findByUsername(usernameNorm) {
    const [rows] = await this.pool.execute(
      'SELECT id, username, password_hash AS passwordHash, is_active AS isActive FROM web_users WHERE username = ? LIMIT 1',
      [usernameNorm]
    );
    const row = rows[0];
    return row ? { ...row, isActive: !!row.isActive } : null;
  }

  /** Melempar err.code='ER_DUP_ENTRY' jika username sudah dipakai. */
  async create({ username, passwordHash }) {
    const [res] = await this.pool.execute(
      'INSERT INTO web_users (username, password_hash, is_active) VALUES (?, ?, 1)',
      [username, passwordHash]
    );
    return res.insertId;
  }

  async setActive(id, isActive) {
    const [res] = await this.pool.execute(
      'UPDATE web_users SET is_active = ? WHERE id = ?',
      [isActive ? 1 : 0, id]
    );
    return res.affectedRows > 0;
  }

  async count() {
    const [rows] = await this.pool.execute('SELECT COUNT(*) AS cnt FROM web_users');
    return rows[0].cnt;
  }
}

/**
 * Adapter ke interface accountStore createWebApp():
 * findByUsername(username) -> { id, username, passwordHash, isActive } | null.
 * Normalisasi lowercase + trim di sini agar semua pemanggil konsisten.
 */
function createDbAccountStore(repo) {
  return {
    async findByUsername(username) {
      if (typeof username !== 'string') return null;
      const norm = username.trim().toLowerCase();
      if (!norm) return null;
      return repo.findByUsername(norm);
    },
  };
}

module.exports = { WebUserRepository, createDbAccountStore };
