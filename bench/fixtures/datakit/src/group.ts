/** Groups items by a key, keeping the order in which keys and items first appear. */
export function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/** Adds up a number per key. */
export function sumBy<T>(items: readonly T[], keyOf: (item: T) => string, valueOf: (item: T) => number): Map<string, number> {
  const sums = new Map<string, number>();
  for (const item of items) sums.set(keyOf(item), (sums.get(keyOf(item)) ?? 0) + valueOf(item));
  return sums;
}
