-- 002_break_minutes.sql
-- Kolom istirahat eksplisit (menit) untuk sesi input manual baru.
-- NULL = data historis tanpa info istirahat → diperlakukan 0 menit
-- (durasi historis dipertahankan sebagaimana tercatat, TIDAK diasumsikan 1 jam).
-- Aman & dapat diulang: hanya menambah kolom, tidak menyentuh data lama.
ALTER TABLE overtime_sessions
  ADD COLUMN break_minutes INT NULL DEFAULT NULL AFTER payable_minutes;