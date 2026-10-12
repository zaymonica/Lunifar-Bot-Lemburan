-- 003_employee_language.sql
-- Preferensi bahasa per pengguna (per Telegram user). Additive & aman:
-- hanya menambah kolom, tidak menyentuh data atau kolom lama.
-- NULL / nilai tak dikenal → fallback 'id' di lapisan aplikasi.
ALTER TABLE employees
  ADD COLUMN language VARCHAR(8) NOT NULL DEFAULT 'id' AFTER department;
