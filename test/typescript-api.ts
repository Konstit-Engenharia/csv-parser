import {
  csv,
  type CsvWhereEqualsFilter,
  parallelCount,
  parallelRows,
  workerPool,
} from '../src/index.ts';

const path = 'example.csv';
declare const dynamicStrict: boolean;
declare const optionalEquals: CsvWhereEqualsFilter | undefined;

const tupleRows: AsyncGenerator<[string, string][], void> = csv.rows(path, {
  columns: [0, 2] as const,
});
const tupleParallelRows: AsyncGenerator<[string, string][], void> = parallelRows(path, {
  columns: [0, 2] as const,
  workerCount: 2,
});
const tupleSelectedColumnsRows: AsyncGenerator<[string, string][], void> = csv.rows(path, {
  selectedColumns: [0, 2] as const,
});
const tuplePoolRows: AsyncGenerator<[string, string][], void> = csv.workerPool(path, {
  columns: [0, 2] as const,
  workerCount: 2,
}).rows();
const tupleDirectPoolRows: AsyncGenerator<[string, string][], void> = workerPool(path, {
  columns: [0, 2] as const,
  workerCount: 2,
}).rows();
void tupleRows;
void tupleParallelRows;
void tupleSelectedColumnsRows;
void tuplePoolRows;
void tupleDirectPoolRows;

void csv.withRowViews(path, { columns: [0, 2] as const }, (row) => {
  const columns: readonly [0, 2] = row.selectedColumns;
  void columns;
});

void csv.withColumnarBatches(path, { columns: [0, 2] as const }, (batch) => {
  const columns: readonly [0, 2] = batch.selectedColumns;
  const rowOffsets: BigUint64Array = batch.rowOffsets();
  const fieldOffsets: BigUint64Array = batch.fieldOffsets();
  void columns;
  void rowOffsets;
  void fieldOffsets;
});

void csv.rows(path, { where: { column: 1, equals: 'SP' } });
void csv.rows(path, { where: optionalEquals });
void parallelCount(path, { workerCount: 2, where: { column: 1, in: ['SP'] } });

// @ts-expect-error dynamic strict state cannot safely combine with filters
void csv.rows(path, { strict: dynamicStrict, where: { column: 1, equals: 'SP' } });

// @ts-expect-error direct parallel count requires workerCount
void parallelCount(path, {});

// @ts-expect-error direct parallel count does not support strict mode
void parallelCount(path, { strict: true, workerCount: 2 });

// @ts-expect-error strict count does not support filters
void csv.count(path, { strict: true, where: { column: 1, equals: 'SP' } });

// @ts-expect-error strict rows do not support filters
void csv.rows(path, { strict: true, where: { column: 1, equals: 'SP' } });

// @ts-expect-error columns and selectedColumns are mutually exclusive
void csv.rows(path, { columns: [0] as const, selectedColumns: [1] as const });

// @ts-expect-error rows() does not support where.in
void csv.rows(path, { where: { column: 1, in: ['SP'] } });

// @ts-expect-error rows() does not support where.startsWith
void csv.rows(path, { where: { column: 1, startsWith: 'S' } });

// @ts-expect-error row views do not support workers
void csv.withRowViews(path, { workerCount: 2 }, () => {});

// @ts-expect-error row views do not support where.in
void csv.withRowViews(path, { where: { column: 1, in: ['SP'] } }, () => {});

// @ts-expect-error batches do not support workers
void csv.batches(path, { workerCount: 2 });

// @ts-expect-error batches do not support where.in
void csv.batches(path, { where: { column: 1, in: ['SP'] } });

// @ts-expect-error columnar batches do not support strict selected columns
void csv.withColumnarBatches(path, { columns: [0] as const, strict: true }, () => {});

// @ts-expect-error count() with workers does not support strict mode
void csv.count(path, { workerCount: 2, strict: true });

// @ts-expect-error count() with strict mode does not support where.in
void csv.count(path, { strict: true, where: { column: 1, in: ['SP'] } });

// @ts-expect-error workerPool requires explicit worker options
void workerPool(path);

// @ts-expect-error workerPool rows support only where.equals
void workerPool(path, { workerCount: 2, where: { column: 1, in: ['SP'] } });

// @ts-expect-error workerPool does not support strict mode
void workerPool(path, { strict: true, workerCount: 2 });
