import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/index.ts';

/** -0 and 0 are the same amount. */
const split = (total: number, weights: number[]): number[] => allocate(total, weights).map(x => x + 0);

/** A weight as a whole number of millionths, read from its decimal digits. */
function millionths(w: number): bigint {
  const [int, frac = ''] = w.toFixed(6).split('.');
  return BigInt(int! + frac);
}

/** The split by exact arithmetic: floor of each proportional share, then the largest remainders, the earlier first. */
function reference(total: number, weights: number[]): number[] {
  const scaled = weights.map(millionths);
  const sum = scaled.reduce((a, w) => a + w, 0n);
  const amount = BigInt(Math.abs(total));
  const shares = scaled.map(w => (amount * w) / sum);
  const rests = scaled.map(w => (amount * w) % sum);
  let left = amount - shares.reduce((a, s) => a + s, 0n);
  const order = rests.map((rest, i) => ({ rest, i })).sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1));
  for (let k = 0; left > 0n; k++, left--) shares[order[k]!.i]! += 1n;
  return shares.map(s => Number(total < 0 ? -s : s) + 0);
}

test('equal remainders go to the earlier weight, with decimal weights too', () => {
  assert.deepEqual(split(10, [0.19, 0.01]), [10, 0]);
  assert.deepEqual(split(1, [0.1, 0.1, 0.1]), [1, 0, 0]);
  assert.deepEqual(split(5, [0.1, 0.3, 0.6]), [1, 1, 3]);
  assert.deepEqual(split(3, [0.7, 0.7, 0.7, 0.7]), [1, 1, 1, 0]);
});

test('shares that are whole numbers stay whole, and the nearest remainders win', () => {
  assert.deepEqual(split(100, [0.1, 63, 5, 0.9]), [0, 92, 7, 1]);
  assert.deepEqual(split(999, [9.4, 0.6, 0.2, 0.6]), [870, 56, 18, 55]);
  assert.deepEqual(split(100, [0.1, 0.2, 0.7]), [10, 20, 70]);
  assert.deepEqual(split(1000, [0.07, 0.14, 0.79]), [70, 140, 790]);
});

test('large totals are split to the last unit', () => {
  assert.deepEqual(split(9007199254740991, [9.69, 5.18]), [5869519890950922, 3137679363790069]);
  assert.deepEqual(split(4503599627370535, [0.1, 9.7, 8.8]), [24212901222422, 2348651418574957, 2130735307573156]);
  assert.deepEqual(split(9007199254740991, [2.5, 7.8, 0.95, 9.06]), [1108714827023756, 3459190260314118, 421311634269027, 4017982533134090]);
  assert.deepEqual(split(4503599627370497, [0.001, 0.763, 0.542]), [3448391751432, 2631122906342794, 1869028329276271]);
  assert.deepEqual(split(9007199254740991, [1, 1, 1]), [3002399751580331, 3002399751580330, 3002399751580330]);
  assert.deepEqual(split(9007199254740991, [999999999.999999, 0.000001]), [9007199254740982, 9]);
});

test('a negative total is the mirror image of the positive split', () => {
  assert.deepEqual(split(-10, [0.19, 0.01]), [-10, 0]);
  assert.deepEqual(split(-999, [9.4, 0.6, 0.2, 0.6]), [-870, -56, -18, -55]);
  assert.deepEqual(split(-9007199254740991, [9.69, 5.18]), [-5869519890950922, -3137679363790069]);
});

test('a zero weight never gets a unit', () => {
  assert.deepEqual(split(7, [0, 0.3, 0, 0.3]), [0, 4, 0, 3]);
  assert.deepEqual(split(1, [0, 0.000001]), [0, 1]);
});

test('many splits agree with exact arithmetic', () => {
  let seed = 20261118;
  const next = () => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x80000000; };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)]!;
  for (let n = 0; n < 4000; n++) {
    const digits = pick([0, 1, 1, 2, 2, 3, 6]);
    const weights = Array.from({ length: 2 + Math.floor(next() * 5) }, () => Number((Math.floor(next() * pick([10, 100, 1000, 100000])) / 10 ** digits).toFixed(digits)));
    if (weights.every(w => w === 0)) weights[0] = 1;
    const base = pick([0, 1, 7, 100, 999, 12345, 1000000, 123456789012345, 4503599627370497, 9007199254740000]);
    const total = (base + Math.floor(next() * 990)) * pick([1, 1, 1, -1]);
    const got = split(total, weights);
    assert.deepEqual(got, reference(total, weights), `allocate(${total}, ${JSON.stringify(weights)})`);
    assert.equal(got.reduce((a, b) => a + BigInt(b), 0n), BigInt(total), `the shares of allocate(${total}, ${JSON.stringify(weights)}) add up`);
  }
});
