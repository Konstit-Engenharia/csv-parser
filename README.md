# @konstit/csv-parser

Bun-native CSV parser using `bun:ffi` and the shared library built from `native/csv_parser.cpp`.

Use it when large CSV files need streaming rows, selected columns, simple filters, dictionary batches, group-by counts, or low-allocation row access.

## Setup

The repository and packaged release artifacts include native libraries for macOS 13+ ARM64/x64 and Linux x64. After
`bun install`, a fresh clone can run the Bun API, examples, and tests without compiling native code.

To rebuild the native libraries while developing C++ code:

```sh
bun install
bun run build:native
bun run stage:native
```

Native development requires CMake 3.25+, Ninja, Git, and Clang/AppleClang. CMake downloads pinned Highway and
unordered_dense sources during the first configure; native test configurations also download pinned Catch2 sources.
The downloaded sources are reused from `.cache/fetchcontent/`.

The native build writes architecture-specific outputs under `build/<platform>-<arch>/`. On macOS, `bun run build:native`
builds both `darwin-arm64` and `darwin-x64`; at runtime the FFI loader picks the library matching `process.platform` and
`process.arch`. Legacy fallback paths such as `build/libcsv_native.*` and root `libcsv_native.*` are still checked for
local development.

On macOS, build and stage the Linux x64 prebuild with Docker Desktop:

```sh
bun run prebuilds:linux
```

The command caches an Ubuntu 24.04 image with Clang, CMake, and Ninja, mounts the repository at `/work`, builds the
existing `linux-x64-release` preset, and stages `prebuilds/linux-x64/libcsv_native.so`. Release packaging continues to
build Linux x64 natively on the Ubuntu CI runner.

The supported native targets are Clang C++20 builds for macOS ARM64/x64 and Linux x64. ARM64 requires NEON, and x64
requires AVX2. CPUs without those instruction sets are not supported. Target-specific configuration is available through
CMake presets, for example:

```sh
cmake --preset darwin-arm64-release
cmake --build --preset darwin-arm64-release
cmake --preset linux-x64-sanitize
cmake --build --preset linux-x64-sanitize
ctest --preset linux-x64-sanitize
```

If no matching library exists, imports fail with:

```txt
native library not found. Run: bun run build:native
```

Package assembly is separate from publication. The `Package` workflow builds target-specific native libraries on macOS and
Linux, verifies every required target, creates the tarball, and installs that tarball in a clean smoke-test project.
Publication must use this verified artifact; `prepack` rejects packages missing any required native library.

## Quick Start

```ts
import { csv } from '@konstit/csv-parser';

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
import { csv } from '@konstit/csv-parser';

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
- `csv.withRowViews(path, options, callback)` streams reusable row views with managed lifetimes.
- `csv.withColumnarBatches(path, options, callback)` streams reusable columnar batch views.
- `csv.workerPool(path, options)` creates a reusable pool for repeated parallel operations.
- `csv.findCsvSafeSplitOffsets(path, count, options)` and `csv.findCsvSafeShards(path, count, options)` split files at record boundaries.

`rows()` only supports `where.equals`. Use `count()` for `where.in` and `where.startsWith`.

`delimiter` suggests common CSV delimiters in TypeScript while accepting any string. Runtime parsing still requires
exactly one character.

`trustedFixedColumns(count)` enables the fastest fixed-column path for trusted input with no newlines in quoted fields.

## Strict Validation

`strict: true` validates RFC-style quote syntax for row materialization:

```ts
await csv.parse(Buffer.from('id,name\n1,"Ada'), { strict: true });
// throws: native CSV parser failed: strict CSV quote syntax error: unterminated quoted field
```

Strict mode also validates optional schema metadata during row parsing:

```ts
await csv.parse(Buffer.from('id,name\n1,Ada\n'), {
  strict: true,
  expectedHeaders: ['id', 'name'],
  minDataRows: 1,
});
```

- `expectedHeaders` validates the first row exactly.
- `requireHeader` rejects empty input when a header row is required.
- `minDataRows` validates row count after the header row.

Strict mode currently covers row batches, `count()` without filters, `fixedColumns`, the fast `trustedFixedColumns` path,
and row schema metadata. Projected batches, dictionary batches, count filters, and aggregate APIs reject `strict: true`
explicitly until they have strict native variants.

## Typed Options

Use the option factories when you want literal-preserving inference without repeating `satisfies` everywhere:

```ts
import {
  csv,
  defineCountOptions,
  defineRowsOptions,
} from '@konstit/csv-parser';

const columns = [0, 2] as const;

const rowOptions = defineRowsOptions({
  columns,
  delimiter: ';',
  where: { column: 1, equals: 'SP' },
});

const countOptions = defineCountOptions({
  strict: true,
});

for await (const rows of csv.rows('data.csv', rowOptions)) {
  console.log(rows);
}

console.log(await csv.count('data.csv', countOptions));
```

The public option types reject combinations unsupported by the native path, including strict validation with filters or
workers. `columns` and the legacy `selectedColumns` alias are mutually exclusive. Each operation accepts only the
options supported by its native path.

Column indexes are integers from `0` through `2024`. A projection may contain at most 2024 columns and must not repeat
an index; invalid selections fail before parsing begins.

## Batch API

Use batches when you need low allocation row access or byte ranges.

```ts
import { csv } from '@konstit/csv-parser';

await csv.withBatches(
  'data.csv',
  { delimiter: ';' },
  (batch) => {
    batch.forEachRow((row) => {
      console.log({
        rowIndex: row.rowIndex,
        first: row.getPhysical(0),
        bytes: row.bytes(0),
        range: row.range(0),
        selected: row.pickPhysical([0, 2]),
      });
    });
  },
);
```

`row.get()`, `row.getPhysical()`, `row.pick()`, and `row.pickPhysical()` all read physical CSV column indexes.
If you requested projected columns elsewhere in the API, `row.selectedColumns` is metadata that lets you map projected
positions back to source columns.

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

`rowOffsets()`, `fieldOffsets()`, and aggregate `dictionaryOffsets()` return `BigUint64Array`. Convert individual
offsets to `number` only after checking that they are within `Number.MAX_SAFE_INTEGER` and the associated backing data.
`scanColumns()` supplies its JavaScript-safe numeric ranges in a `Float64Array`. Column and dictionary IDs remain
`Uint32Array`.

## Manual Parser API

Use `NativeCsvParser` when you already own chunking:

```ts
import { NativeCsvParser } from '@konstit/csv-parser';

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

Resource objects expose `close()`, `dispose()`, `closed`, and `Symbol.dispose`, so explicit-resource-management syntax works
in Bun:

```ts
using parser = new NativeCsvParser({ delimiter: ';' });
using batch = parser.writeBatch(Buffer.from('1;Ana\n'), true);
console.log(batch.rows());
```

## Examples

```sh
bun run example:api:rows
bun run example:api:batches
bun run example:api:count
bun run example:api:aggregates
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
bun test
bun run lint
```

Full-file benchmarks against `example.csv` are long CPU-bound runs. Run them separately when comparing numbers.

Small correctness/performance smoke:

```sh
bun run bench:regression-smoke
bun run bench:csv-parser:guard
```

## License

MIT © 2026 KONSTIT ENGENHARIA E TECNOLOGIA LTDA. See [`LICENSE`](./LICENSE) and
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
