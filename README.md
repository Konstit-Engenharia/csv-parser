# bun-csv-parser

Bun-native CSV parser using `bun:ffi` and the shared library built from `native/csv_parser.cpp`.

Use it when large CSV files need streaming rows, selected columns, simple filters, dictionary batches, group-by counts, or low-allocation row access.

## Setup

```sh
bun install
bun run build:native
```

The native build writes architecture-specific outputs under `build/<platform>-<arch>/`. On macOS, `bun run build:native`
builds both `darwin-arm64` and `darwin-x64`; at runtime the FFI loader picks the library matching `process.platform` and
`process.arch`. Legacy fallback paths such as `build/libcsv_native.*` and root `libcsv_native.*` are still checked for
local development.

If no matching library exists, imports fail with:

```txt
native library not found. Run: bun run build:native
```

## Quick Start

```ts
import { csv } from 'bun-csv-parser';

const path = 'example.csv';

for await (
  const rows of csv.rows(path, {
    delimiter: ';',
    columns: [0, 1, 2],
    chunkSize: 8 * 1024 * 1024,
  })
) {
  for (const row of rows) {
    console.log(row);
  }
}
```

In this repo, `example.csv` is semicolon-delimited. Pass `delimiter: ';'` for examples and benchmarks that read it.

## High-Level API

Import the `csv` namespace for file-oriented helpers:

```ts
import { csv } from 'bun-csv-parser';

const rows = await csv.count('data.csv', { delimiter: ';' });

const selected = csv.rows('data.csv', {
  delimiter: ';',
  columns: [0, 2],
  where: { column: 2, equals: 'SP' },
});
```

Supported helpers:

- `csv.parse(buffer, options)` parses one buffer and returns rows.
- `csv.rows(path, options)` streams materialized row arrays.
- `csv.batches(path, options)` streams `NativeCsvBatch` objects.
- `csv.withBatches(path, options, callback)` owns batch close handling around a callback.
- `csv.count(path, options)` counts rows, optionally with `equals`, `in`, or `startsWith`.
- `csv.dictionary(path, column, options)` streams dictionary-encoded batches for one column.
- `csv.groupByCount(path, column, options)` returns grouped counts for one column.
- `csv.columnStats(path, column, options)` returns dictionary/count stats for one column.
- `csv.multiColumnStats(path, columns, options)` returns stats for multiple columns.

`rows()` only supports `where.equals`. Use `count()` for `where.in` and `where.startsWith`.

## Fluent File API

`csv.file(path)` builds reusable file options:

```ts
import { csv } from 'bun-csv-parser';

const query = csv
  .file('data.csv')
  .delimiter(';')
  .chunkSize(8 * 1024 * 1024)
  .select([0, 1])
  .whereEquals(2, 'SP');

console.log(await query.count());

for await (const rows of query.rows()) {
  console.log(rows);
}
```

Useful builder methods:

- `delimiter(value)`
- `encoding('utf8' | 'latin1' | 'iso88591' | 'iso-8859-1')`
- `chunkSize(bytes)`
- `select(columns)`
- `fixedColumns(count)`
- `trustedFixedColumns(count)`
- `whereEquals(column, value)`
- `whereIn(column, values)`
- `whereStartsWith(column, prefix)`
- `rows()`, `batches()`, `withBatches()`, `count()`, `dictionary()`, `groupByCount()`, `columnStats()`, `multiColumnStats()`

`trustedFixedColumns(count)` enables the fastest fixed-column path for trusted input with no newlines in quoted fields.

## Strict Validation

`strict: true` validates RFC-style quote syntax for row materialization:

```ts
await csv.parse(Buffer.from('id,name\n1,"Ada'), { strict: true });
// throws: native CSV parser failed: strict CSV quote syntax error: unterminated quoted field
```

Strict mode currently covers row batches, `fixedColumns`, and the fast `trustedFixedColumns` path. Projected batches,
dictionary batches, count filters, and aggregate APIs reject `strict: true` explicitly until they have strict native
variants.

## Batch API

Use batches when you need low allocation row access or byte ranges.

```ts
import { csv } from 'bun-csv-parser';

await csv.withBatches(
  'data.csv',
  { delimiter: ';' },
  (batch) => {
    batch.forEachRow((row) => {
      console.log({
        rowIndex: row.rowIndex,
        first: row.get(0),
        bytes: row.bytes(0),
        range: row.range(0),
        selected: row.pick([0, 2]),
      });
    });
  },
);
```

If you use `csv.batches()` directly, close each batch:

```ts
for await (const batch of csv.batches('data.csv', { delimiter: ';' })) {
  try {
    console.log(batch.rowCount);
  } finally {
    batch.close();
  }
}
```

`NativeCsvBatch` exposes:

- `rowCount`, `totalFields`
- `rows()`
- `rowsInto(target, columns?, stringCache?)`
- `forEachRow(callback)`
- `data()`, `dataView()`
- `rowOffsets()`, `fieldOffsets()`
- `rowFieldCount(rowIndex)`
- `fieldRange(rowIndex, columnIndex)`
- `fieldBytes(rowIndex, columnIndex)`
- `fieldBuffer(rowIndex, columnIndex)`
- `fieldString(rowIndex, columnIndex)`
- `countWhereEquals(columnIndex, value)`
- `close()`

## Manual Parser API

Use `NativeCsvParser` when you already own chunking:

```ts
import { NativeCsvParser } from 'bun-csv-parser';

const parser = new NativeCsvParser({ delimiter: ';' });
const rowsBuffer: string[][] = [];

try {
  const batch = parser.writeBatch(Buffer.from('1;Ana\n2;Bia\n'), true);
  try {
    console.log(batch.rowsInto(rowsBuffer));
  } finally {
    batch.close();
  }
} finally {
  parser.close();
}
```

Always close parser-owned batches and the parser. `NativeCsvParser` supports row batches, projected batches, dictionary batches, group-by counts, column stats, multi-column stats, and direct count filters.

## Examples

```sh
bun run example:api:rows
bun run example:api:batches
bun run example:api:count
bun run example:api:aggregates
bun run example:api:builder
bun run example:first-rows
```

Example environment variables:

- `CSV_EXAMPLE_FILE` or `CSV_BENCH_FILE`
- `CSV_EXAMPLE_DELIMITER` or `CSV_BENCH_DELIMITER`
- `CSV_EXAMPLE_CHUNK_SIZE` or `CSV_BENCH_CHUNK_SIZE`
- `CSV_EXAMPLE_COLUMNS`
- `CSV_EXAMPLE_LIMIT` or `CSV_PRINT_ROWS`
- `CSV_EXAMPLE_FILTER_COLUMN`
- `CSV_EXAMPLE_FILTER_VALUE`
- `CSV_EXAMPLE_GROUP_COLUMN`

## Validation

```sh
bun run test
bun run lint
```

Full-file benchmarks against `example.csv` are long CPU-bound runs. Run them separately when comparing numbers.

Small correctness/performance smoke:

```sh
bun run bench:regression-smoke
```
