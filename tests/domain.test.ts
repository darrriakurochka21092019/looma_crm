import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rublesToCents, reserveFor, orderFinance } from '../shared/domain.js';
test('Деньги: точный перевод рублей в копейки и проверка ввода', () => {
  assert.equal(rublesToCents('1 234,56'), 123456);
  assert.equal(rublesToCents('0.01'), 1);
  assert.throws(() => rublesToCents('10.009'));
  assert.throws(() => rublesToCents('-5'));
  assert.throws(() => rublesToCents('Infinity'));
  assert.throws(() => rublesToCents('1e10'));
});
test('Резерв округляется в копейках без потери точности', () => {
  assert.equal(reserveFor(12000000, 600), 720000);
  assert.equal(reserveFor(101, 600), 6);
  assert.equal(reserveFor(-100, 600), 0);
});
test('Аванс не изменяет прибыль, долг и переплата разделены', () => {
  assert.deepEqual(orderFinance(12000000, 0, 7500000, 6000000), {
    total: 12000000,
    actual_cost: 7500000,
    paid: 6000000,
    debt: 6000000,
    overpayment: 0,
    gross_profit: 4500000,
    margin: 37.5,
  });
  assert.equal(orderFinance(10000, 0, 5000, 12000).overpayment, 2000);
});
