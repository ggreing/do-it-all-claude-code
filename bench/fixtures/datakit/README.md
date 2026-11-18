# datakit

Small, dependency-free data helpers used by our import jobs and billing tools.

| Export | Module | What it does |
| --- | --- | --- |
| `CsvStream`, `parseCsv(text)` | `src/csv-stream.ts` | CSV parsing, whole text or chunk by chunk |
| `allocate(total, weights)` | `src/allocate.ts` | Splits an amount of minor units (cents) in proportion to weights |
| `LoadingCache` | `src/loading-cache.ts` | A cache that loads missing values with an async loader |
| `groupBy`, `sumBy` | `src/group.ts` | Grouping helpers |

Everything is re-exported from `src/index.ts`. Invalid arguments and malformed input throw `DatakitError`.

## CSV

```ts
const stream = new CsvStream();
const rows = [...stream.write('id,name\n1,"Kim, J'), ...stream.write('."\n'), ...stream.end()];
// [['id', 'name'], ['1', 'Kim, J.']]
```

- Fields are separated by `,` (or `options.delimiter`). A row ends with `\n`, `\r\n` or a lone `\r`.
- A field that starts with `"` is quoted: it may contain delimiters and line breaks, and `""` inside it is one `"`.
  After the closing quote only a delimiter or a row end may follow.
- An empty line is a row with one empty field. A line break at the very end of the input does not add a row.
- `write(chunk)` returns the rows the chunk completed; `end()` returns the last row, if the input did not end
  with a line break, and makes the stream ready for a new document.

## Allocation

`allocate(total, weights)` returns one whole amount per weight, adding up to `total`. Each share is the exact
proportional share rounded down; the units left over go one each to the shares with the largest remainders,
the earlier weight first when remainders are equal. A negative `total` (a refund) gives the mirror image of the
positive split. Weights are decimal quantities such as `0.1` or `2.5`, with at most 6 fractional digits and
below 1e9; `total` is any safe integer.

## Loading cache

```ts
const prices = new LoadingCache(key => fetchPrice(key), { ttlMs: 60_000 });
await prices.get('sku-1');     // loads
await prices.get('sku-1');     // cached
prices.set('sku-1', 1200);     // stores a value directly
prices.invalidate('sku-1');    // the next get loads again
```

Requires Node 24+ (TypeScript runs natively via type stripping). Run the tests with `npm test`.
