# @konstit/csv

Bun-native CSV parser using `bun:ffi` and the shared library built from `native/csv_parser.cpp`.

Use it when large CSV files need streaming rows, selected columns, simple filters, or low-allocation row access.

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
import { csv } from '@konstit/csv';

const path = 'corpus/large/example.csv';

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

In this repo, `corpus/large/example.csv` is semicolon-delimited. Pass `delimiter: ';'` for examples and benchmarks that read it.

## CLI

Count every CSV record in a file, including the header row:

```sh
bunx @konstit/csv count data.csv
bunx @konstit/csv count data.csv --delimiter ';' --chunk-size 262144
```

With Bun 1.4 or newer, install the command globally and use its shorter form:

```sh
bun add --global @konstit/csv
csv count data.csv
```

The CLI uses one process and exposes the serial `CsvCountOptions` fields as flags. It does not expose `workerCount`.
Run `csv count --help` for the complete list. Friendly filter flags use `column=value`. Repeat `--where-in` for each
accepted value. Different filter clauses combine with AND. CLI filter values are strings; use the TypeScript API for
`workerCount` and binary `Buffer` or `Uint8Array` values.

```sh
csv count data.csv --delimiter ';' --where-eq 2=SP
csv count data.csv --where-in 2=SP --where-in 2=RJ --where-prefix 1=A
csv count data.csv --where-regex '1=/^A/i'
```

For generated or advanced filters, `--where <json>` keeps the `CsvWhereFilter` API shape:

```sh
csv count data.csv --where '{"all":[{"column":2,"in":["SP","RJ"]},{"column":1,"startsWith":"A"}]}'
```

## High-Level API

Import the `csv` namespace for file-oriented helpers:

```ts
import { csv } from '@konstit/csv';

const rows = await csv.count('data.csv', { delimiter: ';' });

const selected = csv.rows('data.csv', {
  delimiter: ';',
  columns: [0, 2],
  where: {
    all: [
      { column: 2, in: ['SP', 'RJ'] },
      { column: 1, startsWith: 'A' },
      { column: 3, regex: csv.re(/^[0-9]{5}-[0-9]{3}$/) },
    ],
  },
});

const compressed = csv.rows('data.csv.gz', {
  compression: 'auto',
  delimiter: 'auto',
});

const zipped = csv.rows('export.zip', {
  compression: { format: 'zip', entry: 'data/export.csv' },
});
```

Supported helpers:

- `csv.parse(buffer, options)` parses one buffer and returns rows.
- `csv.rows(path, options)` streams materialized row arrays.
- `csv.batches(path, options)` streams `NativeCsvBatch` objects.
- `csv.withBatches(path, options, callback)` owns batch close handling around a callback.
- `csv.count(path, options)` counts rows, optionally with native filters.
- `csv.withRowViews(path, options, callback)` streams reusable row views with managed lifetimes.
- `csv.withColumnarBatches(path, options, callback)` streams reusable columnar batch views.
- `csv.workerPool(path, options)` creates a reusable pool for repeated parallel operations.
- `csv.findCsvSafeSplitOffsets(path, count, options)` and `csv.findCsvSafeShards(path, count, options)` split files at record boundaries.

All row and count APIs support `equals`, `in`, `startsWith`, and `regex`. Create regex filters with `csv.re()`:

```ts
const selected = csv.rows('data.csv', {
  where: { column: 1, regex: csv.re(/^ana$/iu) },
});
```

Regex filters use statically linked RE2 and search the field. Use `^` and `$` for a full-field match. The supported flags
are `i`, `m`, `s`, and `u`. Unicode matching is enabled by default; `u` documents the JavaScript pattern intent. The
`g`, `d`, `y`, and `v` flags are rejected. RE2 does not support lookaround or backreferences. `csv.re()` converts
JavaScript Unicode escapes and escaped `/` characters, then validates the RE2 expression immediately. A compiled
pattern is limited to 4096 UTF-8 bytes, and one operation can use at most 32 regex filters.

Use `where: { all: [...] }` to require multiple
predicates. Every predicate in `all` must match the same row. At least one predicate is required.

Serial file operations accept `compression: 'auto' | 'gzip' | 'deflate' | 'deflate-raw' | 'brotli' | 'zstd'`.
Decompression streams into the parser and does not buffer the complete file. `auto` reads at most four prefix bytes and
combines signatures with `.gz`, `.gzip`, `.zst`, `.zstd`, `.br`, `.zz`, `.zlib`, `.deflate`, or `.deflate-raw`.
Signature and extension mismatches fail. A `.deflate` file without a zlib wrapper requires explicit `deflate-raw`.
Compressed input does not support worker pools, parallel operations, or CSV byte-offset sharding.

ZIP input uses `compression: { format: 'zip', entry: 'path/in/archive.csv' }`. The selected stored or DEFLATE entry
is decoded in bounded native chunks with zlib-ng AVX2 or NEON acceleration. Entry names must match exactly. Encrypted
entries and compression methods other than stored and DEFLATE fail. The defaults limit output to 64 GiB and the
declared compression ratio to 1000. Use `maxDecompressedBytes` and `maxCompressionRatio` to set lower application
limits or to permit a larger trusted entry.

Serial file operations also accept `delimiter: 'auto'`. Detection probes at most 64 KiB of decompressed data and
ignores separators inside quoted fields. It checks comma, tab, semicolon, pipe, colon, caret, and tilde. The `.csv`,
`.tsv`, `.tab`, and `.psv` extensions are confirmed hints, including before a compression extension such as `.gz`.
Empty, single-column, inconsistent, and ambiguous probes fail with an error. Omitted `delimiter` still means comma.
Automatic delimiter detection does not support in-memory parsing, workers, parallel operations, or byte-offset sharding.

`delimiter` suggests common CSV delimiters in TypeScript while accepting any string. Runtime parsing still requires
exactly one character unless a serial file operation uses `auto`.

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

Strict mode currently covers row batches, `count()` without filters, `fixedColumns`, and row schema metadata. Projected
batches and count filters reject `strict: true` explicitly until they have strict native variants.

## Typed Options

Use the option factories when you want literal-preserving inference without repeating `satisfies` everywhere:

```ts
import {
  csv,
  defineCountOptions,
  defineRowsOptions,
} from '@konstit/csv';

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
import { csv } from '@konstit/csv';

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

If you use `csv.batches()` directly, declare each batch with `using` so it is disposed after its iteration:

```ts
for await (using batch of csv.batches('data.csv', { delimiter: ';' })) {
  console.log(batch.rowCount);
}
```

`NativeCsvBatch` exposes:

- `rowCount`, `totalFields`
- `rows()`
- `rowsInto(target, columns?)`
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

`rowOffsets()` and `fieldOffsets()` return `BigUint64Array`. Convert individual offsets to `number` only after checking
that they are within `Number.MAX_SAFE_INTEGER` and the associated backing data. `scanColumns()` supplies its
JavaScript-safe numeric ranges in a `Float64Array`.

## Manual Parser API

Use `NativeCsvParser` when you already own chunking:

```ts
import { NativeCsvParser } from '@konstit/csv';

using parser = new NativeCsvParser({ delimiter: ';' });
const rowsBuffer: string[][] = [];

using batch = parser.writeBatch(Buffer.from('1;Ana\n2;Bia\n'), true);
console.log(batch.rowsInto(rowsBuffer));
```

Always dispose parser-owned batches and the parser. `NativeCsvParser` supports row batches, projected batches, and direct
count filters.

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

## Validation

```sh
bun run test
bun run lint
```

Install the repository's pre-push hook once per clone:

```sh
bun run hooks:install
```

Before every push, the hook builds the host's native libraries and the Linux x64 library, checks TypeScript and C++
formatting, runs the linters and type checker, and runs both the Bun and native test suites. Building Linux x64 requires
Docker to be installed and running. Run the same checks manually with `bun run prepush`.

Full-file benchmarks against `corpus/large/example.csv` are long CPU-bound runs. Run them separately when comparing numbers.

Small correctness/performance smoke:

```sh
bun run bench:regression-smoke
bun run bench:csv-parser:guard
```

## License

MIT © 2026 KONSTIT ENGENHARIA E TECNOLOGIA LTDA. See [`LICENSE`](./LICENSE) and
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
