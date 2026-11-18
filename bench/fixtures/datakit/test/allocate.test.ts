import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatakitError, allocate } from '../src/index.ts';

test('allocate splits in proportion and the shares add up', () => {
  assert.deepEqual(allocate(100, [1, 1]), [50, 50]);
  assert.deepEqual(allocate(100, [3, 1]), [75, 25]);
  assert.deepEqual(allocate(0, [2, 5]), [0, 0]);
});

test('units left over go to the largest remainders, the earlier weight first', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(5, [1, 1]), [3, 2]);
  assert.deepEqual(allocate(10, [1, 2, 4]), [1, 3, 6]);
});

test('a zero weight gets nothing; a negative total mirrors the positive split', () => {
  assert.deepEqual(allocate(7, [0, 1, 0]), [0, 7, 0]);
  assert.deepEqual(allocate(-5, [1, 1]), [-3, -2]);
});

test('invalid arguments throw', () => {
  assert.throws(() => allocate(1.5, [1]), DatakitError);
  assert.throws(() => allocate(10, []), DatakitError);
  assert.throws(() => allocate(10, [1, -1]), DatakitError);
  assert.throws(() => allocate(10, [0, 0]), DatakitError);
});
