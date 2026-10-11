'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatInTz, startOfDayInTz } = require('../src/utils/date-time');

test('format Asia/Jakarta (UTC+7)', () => {
  const d = new Date('2026-01-05T17:30:00Z');
  assert.strictEqual(formatInTz(d, 'Asia/Jakarta'), '2026-01-06 00:30:00');
});

test('format UTC', () => {
  const d = new Date('2026-01-05T17:30:00Z');
  assert.strictEqual(formatInTz(d, 'UTC'), '2026-01-05 17:30:00');
});

test('startOfDayInTz Jakarta', () => {
  // 2026-01-05 00:00 WIB = 2026-01-04 17:00 UTC
  const d = startOfDayInTz('2026-01-05T10:00:00Z', 'Asia/Jakarta');
  assert.strictEqual(d.toISOString(), '2026-01-04T17:00:00.000Z');
});

test('startOfDayInTz UTC', () => {
  const d = startOfDayInTz('2026-01-05T10:00:00Z', 'UTC');
  assert.strictEqual(d.toISOString(), '2026-01-05T00:00:00.000Z');
});
