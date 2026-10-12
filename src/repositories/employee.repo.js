'use strict';

/** Repositori employees. Semua query memakai prepared statements. */

class EmployeeRepo {
  constructor(pool) { this.pool = pool; }

  async findByTelegramId(telegramUserId, conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute(
      'SELECT * FROM employees WHERE telegram_user_id = ? LIMIT 1',
      [telegramUserId]
    );
    return rows[0] || null;
  }

  async findById(id, conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute('SELECT * FROM employees WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async create({ telegramUserId, fullName, employeeNumber, department }, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      'INSERT INTO employees (telegram_user_id, full_name, employee_number, department, role, status) VALUES (?, ?, ?, ?, ?, ?)',
      [telegramUserId, fullName, employeeNumber || null, department, 'employee', 'active']
    );
    return res.insertId;
  }

  async list({ status = null, search = null, limit = 50, offset = 0 } = {}, conn) {
    const c = conn || this.pool;
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (search) {
      where.push('(full_name LIKE ? OR employee_number LIKE ? OR department LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const sql = `SELECT * FROM employees ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ?`;
    params.push(Number(offset) || 0);
    const [rows] = await c.execute(sql, params);
    return rows;
  }

  async setStatus(id, status, isActive, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      'UPDATE employees SET status = ?, is_active = ? WHERE id = ?',
      [status, isActive ? 1 : 0, id]
    );
    return res.affectedRows > 0;
  }

  /** Simpan preferensi bahasa per pengguna (kolom employees.language, migration 003). */
  async setLanguage(id, language, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      'UPDATE employees SET language = ? WHERE id = ?',
      [language, id]
    );
    return res.affectedRows > 0;
  }

  async setRole(id, role, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute('UPDATE employees SET role = ? WHERE id = ?', [role, id]);
    return res.affectedRows > 0;
  }

  async countByStatus(conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute('SELECT status, COUNT(*) AS cnt FROM employees GROUP BY status');
    return rows;
  }
}

module.exports = { EmployeeRepo };
