-- Migration 005: audit log aksi admin web (additive-only).
-- Tidak mengubah tabel/migration lama. Tidak ada secret/password/token di tabel ini.

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  web_user_id BIGINT UNSIGNED NULL,
  username    VARCHAR(64)  NULL,
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(64)  NULL,
  entity_id   VARCHAR(64)  NULL,
  detail      VARCHAR(500) NULL,
  ip          VARCHAR(45)  NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin_audit_created (created_at),
  KEY idx_admin_audit_action (action),
  KEY idx_admin_audit_user (web_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
