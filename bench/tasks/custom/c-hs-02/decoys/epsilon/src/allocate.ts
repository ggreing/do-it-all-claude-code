// A plausible fix that is wrong: it keeps the floating-point arithmetic and adds a tolerance. A tolerance fixes
// the reported example and cannot be right for both small and large totals: near 9e15 one unit in the last
// place is already 1, and remainders that are equal still compare as unequal by a few units in the last place
// below the tolerance of their own magnitude.
import { DatakitError } from './errors.ts';

const EPSILON = 1e-9;

export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new DatakitError('total must be a safe integer');
  if (weights.length === 0) throw new DatakitError('weights must not be empty');
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new DatakitError('weights must be finite and not negative');
  }
  const sum = weights.reduce((a, w) => a + w, 0);
  if (sum === 0) throw new DatakitError('at least one weight must be positive');

  const sign = total < 0 ? -1 : 1;
  const amount = Math.abs(total);
  const exact = weights.map(w => (amount * w) / sum);
  const shares = exact.map(x => Math.floor(x + EPSILON));
  let left = amount - shares.reduce((a, s) => a + s, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x + EPSILON) }))
    .sort((a, b) => (Math.abs(b.rest - a.rest) < EPSILON ? a.i - b.i : b.rest - a.rest));
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) shares[order[k]!.i]! += 1;
  return shares.map(s => (s === 0 ? 0 : sign * s));
}
