'use strict';

/**
 * Interface penyimpanan akun admin web (Tahap 1).
 *
 * Kontrak yang harus dipenuhi store produksi (tahap berikutnya, migration
 * `web_users`): findByUsername(username) -> { id, username, passwordHash } | null.
 * Store di bawah hanyalah implementasi in-memory untuk pengujian dan
 * bootstrap lokal — BUKAN untuk produksi.
 */

class InMemoryAccountStore {
  constructor(users = []) {
    this.users = new Map(users.map((u) => [String(u.username).toLowerCase(), u]));
  }

  async findByUsername(username) {
    if (typeof username !== 'string') return null;
    return this.users.get(username.trim().toLowerCase()) || null;
  }

  /** Hanya untuk test/fixture. */
  addUser(user) {
    this.users.set(String(user.username).toLowerCase(), user);
  }
}

function createInMemoryAccountStore(users) {
  return new InMemoryAccountStore(users);
}

module.exports = { InMemoryAccountStore, createInMemoryAccountStore };
