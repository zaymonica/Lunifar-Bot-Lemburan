'use strict';

/**
 * Audit log aksi admin web → tabel admin_audit_logs (migration 005).
 * Tidak pernah menyimpan password/token penuh/cookie; detail dipotong 500 char.
 */

class AdminAuditRepo {
  constructor(pool) {
    this.pool = pool;
  }

  async log({ webUserId = null, username = null, action, entityType = null, entityId = null, detail = null, ip = null }) {
    await this.pool.execute(
      'INSERT INTO admin_audit_logs (web_user_id, username, action, entity_type, entity_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [webUserId, username, String(action).slice(0, 64), entityType, entityId == null ? null : String(entityId).slice(0, 64), detail ? String(detail).slice(0, 500) : null, ip ? String(ip).slice(0, 45) : null]
    );
  }

  async list({ limit = 50, offset = 0, action = null } = {}) {
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const where = [];
    const params = [];
    if (action) { where.push('action = ?'); params.push(String(action).slice(0, 64)); }
    const sql = `SELECT id, web_user_id, username, action, entity_type, entity_id, detail, ip, created_at
      FROM admin_audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limitNum} OFFSET ?`;
    params.push(Number(offset) || 0);
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }
}

/** Helper request-level: ambil aktor & IP dari req lalu tulis audit. */
function makeAuditLogger(repo) {
  return async function audit(req, action, entityType, entityId, detail) {
    const s = req.session || {};
    return repo.log({
      webUserId: s.userId ?? null,
      username: s.username ?? null,
      action,
      entityType: entityType || null,
      entityId: entityId == null ? null : entityId,
      detail: detail || null,
      ip: req.ip || null,
    });
  };
}

module.exports = { AdminAuditRepo, makeAuditLogger };
