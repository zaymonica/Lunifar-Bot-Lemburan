'use strict';

class AppError extends Error {
  constructor(message, code = 'APP_ERROR', status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.userMessage = message; // pesan aman untuk user
  }
}

class ValidationError extends AppError {
  constructor(message) { super(message, 'VALIDATION', 400); }
}
class AuthError extends AppError {
  constructor(message = 'Anda tidak memiliki akses untuk aksi ini.') { super(message, 'AUTH', 403); }
}
class ConflictError extends AppError {
  constructor(message) { super(message, 'CONFLICT', 409); }
}
class NotFoundError extends AppError {
  constructor(message = 'Data tidak ditemukan.') { super(message, 'NOT_FOUND', 404); }
}
class DbError extends AppError {
  constructor(message = 'Terjadi kesalahan database. Silakan coba lagi.') {
    super(message, 'DB_ERROR', 500);
  }
}

function toUserMessage(err) {
  if (err instanceof AppError) return err.userMessage;
  // Jangan bocorkan detail internal (query, kredensial, dsb)
  return 'Terjadi kesalahan internal. Silakan coba lagi nanti.';
}

module.exports = { AppError, ValidationError, AuthError, ConflictError, NotFoundError, DbError, toUserMessage };
