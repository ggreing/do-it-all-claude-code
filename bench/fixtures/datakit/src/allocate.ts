import { DatakitError } from './errors.ts';

/**
 * Splits `total` minor units (cents) in proportion to `weights`. Every share is a whole number and the shares
 * add up to `total`: each gets its proportional share rounded down, and the units left over go one each to the
 * shares with the largest remainders (the earlier weight first when remainders are equal). A negative total
 * gives the mirror image of the positive split.
 */
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
  const shares = exact.map(x => Math.floor(x));
  let left = amount - shares.reduce((a, s) => a + s, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) shares[order[k]!.i]! += 1;
  return shares.map(s => (s === 0 ? 0 : sign * s));
}
