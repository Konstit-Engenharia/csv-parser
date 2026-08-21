import {
  csv,
  type CsvCompression,
  type CsvDelimiter,
  type CsvWhereEqualsFilter,
  parallelCount,
  parallelRows,
  workerPool,
} from '../src/index.ts';

const path = 'corpus/large/example.csv';
declare const dynamicStrict: boolean;
declare const optionalEquals: CsvWhereEqualsFilter | undefined;
const autoCompression: CsvCompression = 'auto';
void autoCompression;
const zipCompression: CsvCompression = { entry: 'data.csv', format: 'zip' };
void zipCompression;
const autoDelimiter: CsvDelimiter = 'auto';
void autoDelimiter;

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
using tuplePool = csv.workerPool(path, {
  columns: [0, 2] as const,
  workerCount: 2,
});
const tuplePoolRows: AsyncGenerator<[string, string][], void> = tuplePool.rows();
using tupleDirectPool = workerPool(path, {
  columns: [0, 2] as const,
  workerCount: 2,
});
const tupleDirectPoolRows: AsyncGenerator<[string, string][], void> = tupleDirectPool.rows();
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
void csv.rows(path, { where: { column: 1, in: ['SP'] } });
void csv.rows(path, { where: { column: 1, startsWith: 'S' } });
void csv.rows(path, {
  where: {
    all: [
      { column: 1, startsWith: 'A' },
      { column: 2, in: ['SP', 'RJ'] },
    ],
  },
});
void csv.rows(path, { compression: 'gzip' });
void csv.rows(path, { compression: 'auto' });
void csv.rows(path, { compression: { entry: 'data.csv', format: 'zip' } });
void csv.rows(path, { delimiter: 'auto' });
void csv.batches(path, { compression: 'brotli' });
void csv.batches(path, { delimiter: 'auto' });
void csv.count(path, { compression: 'zstd' });
void csv.count(path, { delimiter: 'auto' });
void parallelCount(path, { workerCount: 2, where: { column: 1, in: ['SP'] } });
void parallelRows(path, {
  workerCount: 2,
  where: { all: [{ column: 1, startsWith: 'A' }, { column: 2, equals: 'SP' }] },
});
using filteredPool = workerPool(path, {
  workerCount: 2,
  where: { all: [{ column: 1, startsWith: 'A' }, { column: 2, equals: 'SP' }] },
});
void filteredPool.count();
void filteredPool.rows();

// @ts-expect-error parse() receives decompressed bytes, not a compressed file
void csv.parse(Buffer.from(''), { compression: 'gzip' });

// @ts-expect-error compressed rows do not support worker sharding
void csv.rows(path, { compression: 'gzip', workerCount: 2 });

// @ts-expect-error ZIP rows do not support worker sharding
void csv.rows(path, { compression: { entry: 'data.csv', format: 'zip' }, workerCount: 2 });

// @ts-expect-error direct parallel rows do not support compressed input
void parallelRows(path, { compression: 'gzip', workerCount: 2 });

// @ts-expect-error compressed counts do not support worker sharding
void csv.count(path, { compression: 'gzip', workerCount: 2 });

// @ts-expect-error direct parallel count does not support compressed input
void parallelCount(path, { compression: 'gzip', workerCount: 2 });

// @ts-expect-error worker pools do not support compressed input
void workerPool(path, { compression: 'gzip', workerCount: 2 });

// @ts-expect-error CSV byte-offset sharding does not support compressed input
void csv.findCsvSafeShards(path, 2, { compression: 'gzip' });

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

// @ts-expect-error row views do not support workers
void csv.withRowViews(path, { workerCount: 2 }, () => {});

void csv.withRowViews(path, { where: { column: 1, in: ['SP'] } }, () => {});

// @ts-expect-error batches do not support workers
void csv.batches(path, { workerCount: 2 });

void csv.batches(path, { where: { column: 1, in: ['SP'] } });

// @ts-expect-error columnar batches do not support strict selected columns
void csv.withColumnarBatches(path, { columns: [0] as const, strict: true }, () => {});

// @ts-expect-error count() with workers does not support strict mode
void csv.count(path, { workerCount: 2, strict: true });

// @ts-expect-error count() with strict mode does not support where.in
void csv.count(path, { strict: true, where: { column: 1, in: ['SP'] } });

// @ts-expect-error workerPool requires explicit worker options
void workerPool(path);

void workerPool(path, { workerCount: 2, where: { column: 1, in: ['SP'] } });

// @ts-expect-error workerPool does not support strict mode
void workerPool(path, { strict: true, workerCount: 2 });
