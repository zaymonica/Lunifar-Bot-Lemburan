-- Migration 001: inisialisasi skema awal (idempoten — aman dijalankan ulang)
-- Catatan: migration dijalankan oleh scripts/db-migrate.js, bukan via CLI MySQL.

CREATE TABLE IF NOT EXISTS employees (
  id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  telegram_user_id BIGINT UNSIGNED NOT NULL,
  full_name       VARCHAR(120) NOT NULL,
  employee_number VARCHAR(40) NULL,
  department      VARCHAR(80) NOT NULL,
  role            ENUM('employee','supervisor','admin') NOT NULL DEFAULT 'employee',
  status          ENUM('pending','active','rejected','inactive') NOT NULL DEFAULT 'pending',
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_employees_telegram_id (telegram_user_id),
  KEY idx_employees_status (status),
  KEY idx_employees_department (department)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS overtime_sessions (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  employee_id    BIGINT UNSIGNED NOT NULL,
  note           VARCHAR(500) NULL,
  start_at       DATETIME NOT NULL,
  end_at         DATETIME NULL,
  actual_minutes INT NULL,
  payable_minutes INT NULL,
  status         ENUM('active','pending','approved','rejected','completed') NOT NULL DEFAULT 'active',
  active_flag    TINYINT(1) GENERATED ALWAYS AS (IF(status = 'active', 1, NULL)) STORED,
  approved_by    BIGINT UNSIGNED NULL,
  decided_at     DATETIME NULL,
  decision_note  VARCHAR(500) NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_sessions_employee FOREIGN KEY (employee_id) REFERENCES employees(id),
  CONSTRAINT fk_sessions_approver FOREIGN KEY (approved_by) REFERENCES employees(id),
  UNIQUE KEY uq_active_session_per_employee (employee_id, active_flag),
  KEY idx_sessions_employee_time (employee_id, start_at),
  KEY idx_sessions_status (status),
  KEY idx_sessions_start_at (start_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS overtime_approvals (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id   BIGINT UNSIGNED NOT NULL,
  approver_id  BIGINT UNSIGNED NOT NULL,
  action       ENUM('approved','rejected') NOT NULL,
  note         VARCHAR(500) NULL,
  acted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_approvals_session FOREIGN KEY (session_id) REFERENCES overtime_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_approvals_approver FOREIGN KEY (approver_id) REFERENCES employees(id),
  UNIQUE KEY uq_one_decision_per_session (session_id),
  KEY idx_approvals_approver (approver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_telegram_id BIGINT UNSIGNED NULL,
  action      VARCHAR(80) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  entity_id   BIGINT UNSIGNED NULL,
  detail      VARCHAR(1000) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_action (action),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key   VARCHAR(60) PRIMARY KEY,
  setting_value VARCHAR(500) NOT NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

