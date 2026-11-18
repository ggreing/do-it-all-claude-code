import { DatakitError } from './errors.ts';

/** Weights have at most this many fractional digits (README), so this factor makes each a whole number. */
const SCALE = 1_000_000;

/**
 * Splits `total` minor units (cents) in proportion to `weights`. Every share is a whole number and the shares
 * add up to `total`: each gets its proportional share rounded down, and the units left over go one each to the
 * shares with the largest remainders (the earlier weight first when remainders are equal). A negative total
 * gives the mirror image of the positive split.
 *
 * The arithmetic is exact: weights become whole numbers of millionths and the products are BigInt, so a share
 * that is a whole number, or two remainders that are equal, are seen as such.
 */
export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new DatakitError('total must be a safe integer');
  if (weights.length === 0) throw new DatakitError('weights must not be empty');
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new DatakitError('weights must be finite and not negative');
  }
  const scaled = weights.map(w => BigInt(Math.round(w * SCALE)));
  const sum = scaled.reduce((a, w) => a + w, 0n);
  if (sum === 0n) throw new DatakitError('at least one weight must be positive');

  const negative = total < 0;
  const amount = BigInt(Math.abs(total));
  const shares = scaled.map(w => (amount * w) / sum);
  const rests = scaled.map(w => (amount * w) % sum);
  let left = amount - shares.reduce((a, s) => a + s, 0n);
  const order = rests
    .map((rest, i) => ({ rest, i }))
    .sort((a, b) => (a.rest === b.rest ? a.i - b.i : a.rest > b.rest ? -1 : 1));
  for (let k = 0; left > 0n; k++, left--) shares[order[k]!.i]! += 1n;
  return shares.map(s => (s === 0n ? 0 : Number(negative ? -s : s)));
}
