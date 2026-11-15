'use strict';
const assert = require('node:assert');
const { calculate, addMonths } = require('../server/interest');

const loan = { date: '2026-01-01', amount: 10000, rate: 2, upfront: 200 };
const t = (name, fn) => { fn(); console.log('ok  -', name); };

t('month-end clamping', () => {
  assert.strictEqual(addMonths('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(addMonths('2028-01-31', 1), '2028-02-29');
  assert.strictEqual(addMonths('2026-11-15', 3), '2027-02-15');
});

t('same day: 1 month charged, fully covered by upfront deduction', () => {
  const r = calculate(loan, [], '2026-01-01');
  assert.strictEqual(r.monthsCharged, 1);
  assert.strictEqual(r.interestDue, 0);
  assert.strictEqual(r.totalDue, 10000);
});

t('exactly 3 months: 3 months charged, minus upfront', () => {
  const r = calculate(loan, [], '2026-04-01');
  assert.strictEqual(r.monthsCharged, 3);
  assert.strictEqual(r.interestAccrued, 600);
  assert.strictEqual(r.interestDue, 400);
  assert.strictEqual(r.totalDue, 10400);
});

t('one day into month 4 charges a 4th month', () => {
  const r = calculate(loan, [], '2026-04-02');
  assert.strictEqual(r.monthsCharged, 4);
  assert.strictEqual(r.interestDue, 600);
});

t('12 months: unpaid interest is added to principal', () => {
  const r = calculate(loan, [], '2027-01-01');
  assert.strictEqual(r.monthsCharged, 12);
  assert.strictEqual(r.principal, 12200);
  assert.strictEqual(r.interestDue, 0);
  assert.strictEqual(r.totalDue, 12200);
  assert.strictEqual(r.capitalizations.length, 1);
});

t('month 13 is charged on the new principal', () => {
  const r = calculate(loan, [], '2027-02-01');
  assert.strictEqual(r.monthsCharged, 13);
  assert.strictEqual(r.interestDue, 244);
  assert.strictEqual(r.totalDue, 12444);
});

t('interest paid during the year is not capitalised', () => {
  const r = calculate(loan, [{ date: '2026-12-31', kind: 'interest', amount: 2200 }], '2027-01-01');
  assert.strictEqual(r.principal, 10000);
  assert.strictEqual(r.interestDue, 0);
  assert.strictEqual(r.totalDue, 10000);
});

t('principal part payment lowers interest from the next month', () => {
  const r = calculate(loan, [{ date: '2026-02-15', kind: 'principal', amount: 5000 }], '2026-04-01');
  // Jan 200 (paid by upfront), Feb 200, Mar on 5000 = 100  -> interest due 300, principal 5000
  assert.strictEqual(r.principal, 5000);
  assert.strictEqual(r.interestDue, 300);
  assert.strictEqual(r.totalDue, 5300);
});

t('payments after the as-of date are ignored', () => {
  const r = calculate(loan, [{ date: '2026-06-01', kind: 'principal', amount: 5000 }], '2026-04-01');
  assert.strictEqual(r.principal, 10000);
});

t('no upfront deduction option', () => {
  const r = calculate({ ...loan, upfront: 0 }, [], '2026-01-01');
  assert.strictEqual(r.interestDue, 200);
});

console.log('\nAll interest tests passed.');
