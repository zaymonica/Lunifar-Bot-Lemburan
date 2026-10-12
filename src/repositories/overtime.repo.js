'use strict';

/** Repositori overtime_sessions, approvals, audit, settings. Prepared statements. */

class OvertimeRepo {
  constructor(pool) { this.pool = pool; }

  async findActiveByEmployee(employeeId, conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute(
      "SELECT * FROM overtime_sessions WHERE employee_id = ? AND status = 'active' LIMIT 1",
      [employeeId]
    );
    return rows[0] || null;
  }

  async createActive(employeeId, note, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      "INSERT INTO overtime_sessions (employee_id, note, start_at, status) VALUES (?, ?, UTC_TIMESTAMP(), 'active')",
      [employeeId, note || null]
    );
    return res.insertId;
  }

  async finishActive(sessionId, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      "UPDATE overtime_sessions SET end_at = UTC_TIMESTAMP(), status = 'pending' WHERE id = ? AND status = 'active'",
      [sessionId]
    );
    return res.affectedRows > 0;
  }

  async findById(id, conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute(
      `SELECT s.*, e.full_name, e.department, e.employee_number,
              a.full_name AS approver_name
       FROM overtime_sessions s
       JOIN employees e ON e.id = s.employee_id
       LEFT JOIN employees a ON a.id = s.approved_by
       WHERE s.id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async listByEmployee(employeeId, { limit = 10, offset = 0 } = {}, conn) {
    const c = conn || this.pool;
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const [rows] = await c.execute(
      `SELECT * FROM overtime_sessions WHERE employee_id = ? ORDER BY start_at DESC LIMIT ${limitNum} OFFSET ?`,
      [employeeId, Number(offset) || 0]
    );
    return rows;
  }

  async setDecision(sessionId, status, approverId, note, actualMinutes, payableMinutes, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      "UPDATE overtime_sessions SET status = ?, approved_by = ?, decided_at = UTC_TIMESTAMP(), decision_note = ?, actual_minutes = ?, payable_minutes = ? WHERE id = ? AND status = 'pending'",
      [status, approverId, note || null, actualMinutes ?? null, payableMinutes ?? null, sessionId]
    );
    return res.affectedRows > 0;
  }

  async search({ employeeId = null, department = null, status = null, fromUtc = null, toUtc = null, limit = 500, offset = 0 } = {}, conn) {
    const c = conn || this.pool;
    const where = [];
    const params = [];
    if (employeeId) { where.push('s.employee_id = ?'); params.push(employeeId); }
    if (department) { where.push('e.department = ?'); params.push(department); }
    if (status) { where.push('s.status = ?'); params.push(status); }
    if (fromUtc) { where.push('s.start_at >= ?'); params.push(fromUtc); }
    if (toUtc) { where.push('s.start_at < ?'); params.push(toUtc); }
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 2000);
    const sql = `
      SELECT s.*, e.full_name, e.department, e.employee_number, a.full_name AS approver_name
      FROM overtime_sessions s
      JOIN employees e ON e.id = s.employee_id
      LEFT JOIN employees a ON a.id = s.approved_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.start_at DESC
      LIMIT ${limitNum} OFFSET ?`;
    params.push(Number(offset) || 0);
    const [rows] = await c.execute(sql, params);
    return rows;
  }

  async statsToday(conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute(
      `SELECT
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending_count
       FROM overtime_sessions`
    );
    return rows[0] || { active_count: 0, pending_count: 0 };
  }

  /** Jalankan fn(conn) dalam satu transaksi; rollback saat error. */
  async withTransaction(fn) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  /** Simpan periode lembur manual (tanggal lampau/kini) sebagai 'completed' (langsung tercatat).
   * actualMinutes/payableMinutes = durasi BERSIH (kotor − istirahat); breakMinutes eksplisit. */
  async createManual(employeeId, startAt, endAt, actualMinutes, payableMinutes, note, conn, breakMinutes = 0) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      `INSERT INTO overtime_sessions
         (employee_id, note, start_at, end_at, actual_minutes, payable_minutes, break_minutes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed')`,
      [employeeId, note || null, startAt, endAt, actualMinutes, payableMinutes, breakMinutes]
    );
    return res.insertId;
  }

  /** Perbarui periode lembur manual (hasil fitur Edit). Status TIDAK diubah di sini —
   * kebijakan status divalidasi di service; actual/payable = durasi BERSIH. */
  async updateManual(sessionId, startAt, endAt, actualMinutes, payableMinutes, breakMinutes, conn) {
    const c = conn || this.pool;
    const [res] = await c.execute(
      `UPDATE overtime_sessions
         SET start_at = ?, end_at = ?, actual_minutes = ?, payable_minutes = ?, break_minutes = ?
       WHERE id = ?`,
      [startAt, endAt, actualMinutes, payableMinutes, breakMinutes, sessionId]
    );
    return res.affectedRows > 0;
  }

  /**
   * Semua sesi selesai (bukan aktif) yang bisa relevan untuk hari lokal
   * [windowStart, windowEnd) — dipakai untuk cek duplikat & tumpang tindih.
   */
  async listByEmployeeAndWindow(employeeId, windowStart, windowEnd, conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute(
      `SELECT * FROM overtime_sessions
       WHERE employee_id = ?
         AND status <> 'active'
         AND start_at < ?
         AND (end_at IS NULL OR end_at > ?)`,
      [employeeId, windowEnd, windowStart]
    );
    return rows;
  }
}

class ApprovalRepo {
  constructor(pool) { this.pool = pool; }

  async record(sessionId, approverId, action, note, conn) {
    const c = conn || this.pool;
    await c.execute(
      'INSERT INTO overtime_approvals (session_id, approver_id, action, note) VALUES (?, ?, ?, ?)',
      [sessionId, approverId, action, note || null]
    );
  }
}

class AuditRepo {
  constructor(pool) { this.pool = pool; }

  async log(actorTelegramId, action, entityType, entityId, detail, conn) {
    const c = conn || this.pool;
    await c.execute(
      'INSERT INTO audit_logs (actor_telegram_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
      [actorTelegramId ?? null, action, entityType, entityId ?? null, detail ? String(detail).slice(0, 1000) : null]
    );
  }
}

class SettingsRepo {
  constructor(pool) { this.pool = pool; }

  async get(key, conn) {
    const c = conn || this.pool;
    const [rows] = await c.execute('SELECT setting_value FROM app_settings WHERE setting_key = ?', [key]);
    return rows[0] ? rows[0].setting_value : null;
  }

  async set(key, value, conn) {
    const c = conn || this.pool;
    await c.execute(
      'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)',
      [key, String(value)]
    );
  }
}

module.exports = { OvertimeRepo, ApprovalRepo, AuditRepo, SettingsRepo };
