import {
  csv,
  type CsvWhereEqualsFilter,
  parallelCount,
  parallelGroupByCount,
  parallelRows,
  workerPool,
} from '../src/index.ts';

const path = 'example.csv';
declare const dynamicStrict: boolean;
declare const optionalEquals: CsvWhereEqualsFilter | undefined;

void csv.file(path).rows();
void csv.file(path).whereEquals(1, 'SP').rows();
void csv.file(path).workers(2).rows();
void csv.file(path).workers(2).pool();
void csv.file(path).stringCache([19]).rows();
void csv.file(path).strict().count();
const tupleRows: AsyncGenerator<[string, string][], void> = csv.file(path).select([0, 2] as const).rows();
const tupleRowsOverride: AsyncGenerator<[string, string][], void> = csv.file(path).select([0, 1, 2] as const).rows({
  columns: [4, 19] as const,
});
const tupleParallelRows: AsyncGenerator<[string, string][], void> = parallelRows(path, {
  columns: [0, 2] as const,
  workerCount: 2,
});
const tupleSelectedColumnsRows: AsyncGenerator<[string, string][], void> = csv.rows(path, {
  selectedColumns: [0, 2] as const,
});
const tuplePoolRows: AsyncGenerator<[string, string][], void> = csv.file(path)
  .select([0, 2] as const)
  .workers(2)
  .pool()
  .rows();
const tupleDirectPoolRows: AsyncGenerator<[string, string][], void> = workerPool(path, {
  columns: [0, 2] as const,
  workerCount: 2,
}).rows();
void tupleRows;
void tupleRowsOverride;
void tupleParallelRows;
void tupleSelectedColumnsRows;
void tuplePoolRows;
void tupleDirectPoolRows;

void csv.file(path).select([0, 2] as const).withRowViews((row) => {
  const columns: readonly [0, 2] = row.selectedColumns;
  void columns;
});

void csv.file(path).select([0, 1, 2] as const).withRowViews((row) => {
  const columns: readonly [4, 19] = row.selectedColumns;
  void columns;
}, {
  columns: [4, 19] as const,
});

void csv.file(path).select([0, 2] as const).withColumnarBatches((batch) => {
  const columns: readonly [0, 2] = batch.selectedColumns;
  void columns;
});

void csv.file(path).select([0, 1, 2] as const).withColumnarBatches((batch) => {
  const columns: readonly [4, 19] = batch.selectedColumns;
  void columns;
}, {
  columns: [4, 19] as const,
});

void csv.withRowViews(path, { columns: [0, 2] as const }, (row) => {
  const columns: readonly [0, 2] = row.selectedColumns;
  void columns;
});

void csv.withColumnarBatches(path, { columns: [0, 2] as const }, (batch) => {
  const columns: readonly [0, 2] = batch.selectedColumns;
  void columns;
});

void csv.rows(path, { where: { column: 1, equals: 'SP' } });
void csv.file(path).whereIn(1, ['SP']).count();
void csv.file(path).workers(2).groupByCount(1);
void csv.file(path).strict().strict(false).whereEquals(1, 'SP').rows();
void csv.file(path).strict(dynamicStrict).count();
void csv.file(path, { where: optionalEquals }).rows();
void parallelCount(path, { workerCount: 2, where: { column: 1, in: ['SP'] } });
void parallelGroupByCount(path, 1, { workerCount: 2 });

// @ts-expect-error dynamic strict state cannot safely combine with filters
void csv.file(path).strict(dynamicStrict).whereEquals(1, 'SP').rows();

// @ts-expect-error dynamic strict state cannot safely combine with workers
void csv.file(path).strict(dynamicStrict).workers(2).pool();

// @ts-expect-error direct parallel count requires workerCount
void parallelCount(path, {});

// @ts-expect-error direct parallel count does not support strict mode
void parallelCount(path, { strict: true, workerCount: 2 });

// @ts-expect-error direct parallel aggregates require workerCount
void parallelGroupByCount(path, 1, {});

// @ts-expect-error strict count does not support filters
void csv.count(path, { strict: true, where: { column: 1, equals: 'SP' } });

// @ts-expect-error strict rows do not support filters
void csv.rows(path, { strict: true, where: { column: 1, equals: 'SP' } });

// @ts-expect-error columns and selectedColumns are mutually exclusive
void csv.rows(path, { columns: [0] as const, selectedColumns: [1] as const });

// @ts-expect-error builder operation overrides cannot change worker state
void csv.file(path).strict().rows({ workerCount: 2 });

// @ts-expect-error builder operation overrides cannot change strict state
void csv.file(path).workers(2).rows({ strict: true });

// @ts-expect-error builder operation overrides cannot change filter state
void csv.file(path).count({ where: { column: 1, equals: 'SP' } });

// @ts-expect-error rows() does not support where.in
void csv.file(path).whereIn(1, ['SP']).rows();

// @ts-expect-error rows() does not support where.startsWith
void csv.file(path).whereStartsWith(1, 'S').rows();

// @ts-expect-error top-level rows() does not support where.in
void csv.rows(path, { where: { column: 1, in: ['SP'] } });

// @ts-expect-error top-level rows() does not support where.startsWith
void csv.rows(path, { where: { column: 1, startsWith: 'S' } });

// @ts-expect-error row views do not support workers
void csv.file(path).workers(2).withRowViews(() => {});

// @ts-expect-error row views do not support where.in
void csv.file(path).whereIn(1, ['SP']).withRowViews(() => {});

// @ts-expect-error batches do not support workers
void csv.file(path).workers(2).batches();

// @ts-expect-error batches do not support where.in
void csv.file(path).whereIn(1, ['SP']).batches();

// @ts-expect-error row views do not support workers from constructor options
void csv.file(path, { workerCount: 2 }).withRowViews(() => {});

// @ts-expect-error top-level row views do not support workers
void csv.withRowViews(path, { workerCount: 2 }, () => {});

// @ts-expect-error columnar batches do not support strict selectedColumns
void csv.file(path).strict().select([0] as const).withColumnarBatches(() => {});

// @ts-expect-error top-level columnar batches do not support strict selectedColumns
void csv.withColumnarBatches(path, { columns: [0] as const, strict: true }, () => {});

// @ts-expect-error count() with workers + strict is runtime-invalid
void csv.file(path).workers(2).strict().count();

// @ts-expect-error count() with strict + where.in is runtime-invalid
void csv.file(path).strict().whereIn(1, ['SP']).count();

// @ts-expect-error top-level count() with workers + strict is runtime-invalid
void csv.count(path, { workerCount: 2, strict: true });

// @ts-expect-error top-level count() with strict + where.in is runtime-invalid
void csv.count(path, { strict: true, where: { column: 1, in: ['SP'] } });

// @ts-expect-error pool() requires workers() in type-level API
void csv.file(path).pool();

// @ts-expect-error pool does not support strict mode
void csv.file(path).strict().workers(2).pool();

// @ts-expect-error pool rows support only where.equals
void csv.file(path).whereIn(1, ['SP']).workers(2).pool();

// @ts-expect-error workerPool requires explicit worker options
void workerPool(path);

// @ts-expect-error workerPool rows support only where.equals
void workerPool(path, { workerCount: 2, where: { column: 1, in: ['SP'] } });

// @ts-expect-error workerPool does not support strict mode
void workerPool(path, { strict: true, workerCount: 2 });

// @ts-expect-error dictionary does not support strict
void csv.file(path).strict().dictionary(1);

// @ts-expect-error dictionary ignores workers and must reject worker state
void csv.file(path).workers(2).dictionary(1);

// @ts-expect-error dictionary does not support filters
void csv.file(path).whereEquals(1, 'SP').dictionary(1);

// @ts-expect-error top-level dictionary does not support strict
void csv.dictionary(path, 1, { strict: true });

// @ts-expect-error groupByCount does not support strict
void csv.file(path).strict().groupByCount(1);

// @ts-expect-error groupByCount does not support filters
void csv.file(path).whereEquals(1, 'SP').groupByCount(1);

// @ts-expect-error top-level groupByCount does not support strict
void csv.groupByCount(path, 1, { strict: true });

// @ts-expect-error top-level groupByCount does not support where
void csv.groupByCount(path, 1, { where: { column: 1, equals: 'SP' } });

// @ts-expect-error columnStats does not support strict
void csv.file(path).strict().columnStats(1);

// @ts-expect-error top-level columnStats does not support strict
void csv.columnStats(path, 1, { strict: true });

// @ts-expect-error top-level columnStats does not support where
void csv.columnStats(path, 1, { where: { column: 1, equals: 'SP' } });

// @ts-expect-error multiColumnStats does not support strict
void csv.file(path).strict().multiColumnStats([1, 2]);

// @ts-expect-error top-level multiColumnStats does not support strict
void csv.multiColumnStats(path, [1, 2], { strict: true });

// @ts-expect-error top-level multiColumnStats does not support where
void csv.multiColumnStats(path, [1, 2], { where: { column: 1, equals: 'SP' } });
