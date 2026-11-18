import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupBy, sumBy } from '../src/index.ts';

const orders = [
  { customer: 'kim', cents: 1200 },
  { customer: 'lee', cents: 300 },
  { customer: 'kim', cents: 50 },
];

test('groupBy keeps first-seen order', () => {
  const groups = groupBy(orders, o => o.customer);
  assert.deepEqual([...groups.keys()], ['kim', 'lee']);
  assert.deepEqual(groups.get('kim')!.map(o => o.cents), [1200, 50]);
});

test('sumBy adds up per key', () => {
  assert.deepEqual([...sumBy(orders, o => o.customer, o => o.cents)], [['kim', 1250], ['lee', 300]]);
});
