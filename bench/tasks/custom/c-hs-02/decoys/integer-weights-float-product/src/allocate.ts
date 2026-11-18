// A plausible fix that is wrong: it turns the weights into whole numbers, which makes small totals exact, and
// still multiplies in floating point. Above 2^53 the products lose their low digits, so large totals are split
// by rounded remainders.
import { DatakitError } from './errors.ts';

export function allocate(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total)) throw new DatakitError('total must be a safe integer');
  if (weights.length === 0) throw new DatakitError('weights must not be empty');
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new DatakitError('weights must be finite and not negative');
  }
  const scaled = weights.map(w => Math.round(w * 1_000_000));
  const sum = scaled.reduce((a, w) => a + w, 0);
  if (sum === 0) throw new DatakitError('at least one weight must be positive');

  const sign = total < 0 ? -1 : 1;
  const amount = Math.abs(total);
  const shares = scaled.map(w => Math.floor((amount * w) / sum));
  const rests = scaled.map(w => (amount * w) % sum);
  let left = amount - shares.reduce((a, s) => a + s, 0);
  const order = rests.map((rest, i) => ({ rest, i })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) shares[order[k]!.i]! += 1;
  return shares.map(s => (s === 0 ? 0 : sign * s));
}
