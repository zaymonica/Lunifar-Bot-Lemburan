'use strict';
const mysql = require('mysql2/promise');

function createPool(dbConfig) {
  return mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    user: dbConfig.user,
    password: dbConfig.password,
    database: dbConfig.database,
    connectionLimit: dbConfig.connectionLimit || 5,
    timezone: 'Z', // simpan/baca sebagai UTC
    namedPlaceholders: false,
    decimalNumbers: true,
    multipleStatements: false,
  });
}

module.exports = { createPool };
