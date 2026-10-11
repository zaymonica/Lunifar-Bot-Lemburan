'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { durationMinutes, roundUpMinutes, payableMinutes, formatDuration } = require('../src/utils/duration');

test('durasi dasar', () => {
  const s = new Date('2026-01-05T10:00:00Z');
  const e = new Date('2026-01-05T12:30:00Z');
  assert.strictEqual(durationMinutes(s, e), 150);
});

test('lintas tengah malam', () => {
  const s = new Date('2026-01-05T22:00:00Z');
  const e = new Date('2026-01-06T02:00:00Z');
  assert.strictEqual(durationMinutes(s, e), 240);
});

test('durasi nol', () => {
  const s = new Date('2026-01-05T10:00:00Z');
  assert.strictEqual(durationMinutes(s, s), 0);
});

test('timestamp tidak valid dilempar', () => {
  assert.throws(() => durationMinutes(new Date('x'), new Date()), /tidak valid/);
  assert.throws(() => durationMinutes('2026', new Date()), /tidak valid/);
});

test('durasi negatif dilempar', () => {
  const s = new Date('2026-01-05T12:00:00Z');
  const e = new Date('2026-01-05T10:00:00Z');
  assert.throws(() => durationMinutes(s, e), /negatif/);
});

test('pembulatan ke atas', () => {
  assert.strictEqual(roundUpMinutes(50, 15), 60);
  assert.strictEqual(roundUpMinutes(45, 15), 45);
  assert.strictEqual(roundUpMinutes(1, 15), 15);
  assert.strictEqual(roundUpMinutes(50, 0), 50); // tanpa pembulatan
});

test('payableMinutes: minimum & pembulatan', () => {
  assert.strictEqual(payableMinutes(20, { minMinutes: 30, roundingMinutes: 15 }), null);
  assert.strictEqual(payableMinutes(50, { minMinutes: 30, roundingMinutes: 15 }), 60);
  assert.strictEqual(payableMinutes(90, { minMinutes: 30, roundingMinutes: 15 }), 90);
});

test('formatDuration', () => {
  assert.strictEqual(formatDuration(150), '2 jam 30 menit');
  assert.strictEqual(formatDuration(45), '45 menit');
});
