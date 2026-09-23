// Regression guard for #17: the vendored matcher must treat nonexistent
// calendar dates as "deadline unknown" (feed contract v1 §4.1).
//
// lib/match-user-subsidy.js is vendored verbatim (dr-005) and must not be
// edited here. This feeder-owned test only exercises its exported functions,
// so a future re-vendoring that drops the calendar round-trip check fails
// here instead of silently printing a nonexistent deadline in the digest.
const { test } = require('node:test');
const assert = require('node:assert');

const { parseDeadline, isOpen } = require('../lib/match-user-subsidy');

const NONEXISTENT = [
  '2027-02-29', // 2027 is not a leap year
  '2026-02-29',
  '2026-04-31',
  '2026-06-31',
  '2026-09-31',
  '2026-11-31',
  '2100-02-29', // divisible by 100 but not by 400
  '2026-13-01',
  '2026-00-10',
  '2026-06-00',
];

const EXISTENT = [
  '2028-02-29', // leap year
  '2000-02-29', // divisible by 400
  '2026-02-28',
  '2026-12-31',
  '2026-01-01',
];

// Fixed basis date so the expectations do not drift with the wall clock.
const TODAY = new Date('2026-06-28T00:00:00Z');

test('parseDeadline: nonexistent calendar dates are unknown (null)', () => {
  for (const deadline of NONEXISTENT) {
    assert.strictEqual(parseDeadline(deadline), null, deadline);
  }
});

test('parseDeadline: existent dates parse to UTC midnight of the same day', () => {
  for (const deadline of EXISTENT) {
    const d = parseDeadline(deadline);
    assert.ok(d instanceof Date, deadline);
    assert.strictEqual(d.toISOString(), `${deadline}T00:00:00.000Z`);
  }
});

test('isOpen: nonexistent calendar dates are never open', () => {
  for (const deadline of NONEXISTENT) {
    assert.strictEqual(isOpen({ application_deadline: deadline }, TODAY), false, deadline);
  }
});

test('isOpen: existent dates follow the deadline (future open, past closed)', () => {
  const expected = {
    '2028-02-29': true,
    '2000-02-29': false,
    '2026-02-28': false,
    '2026-12-31': true,
    '2026-01-01': false,
  };
  for (const deadline of EXISTENT) {
    assert.strictEqual(isOpen({ application_deadline: deadline }, TODAY), expected[deadline], deadline);
  }
});
