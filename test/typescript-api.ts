import {
  csv,
  type CsvCompression,
  type CsvDelimiter,
  type CsvFilter,
  type CsvFilterColumn,
  type CsvNotEqualsFilter,
  type CsvNotInFilter,
  parallelCount,
  parallelRows,
  workerPool,
} from '../src/index.ts';

const path = 'corpus/large/example.csv';
declare const dynamicStrict: boolean;
declare const optionalFilter: CsvFilter | undefined;
const nativeNotEquals: CsvNotEqualsFilter = { column: 1, notEquals: 'SP' };
const nativeNotIn: CsvNotInFilter = { column: 1, notIn: ['SP', 'RJ'] };
void nativeNotEquals;
void nativeNotIn;
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

const state: CsvFilterColumn = csv.column(1);
const stateEquals: CsvFilter = state.equals('SP');
const stateIsOneOf: CsvFilter = state.isOneOf(['SP', 'RJ']);
const stateDoesNotEqual: CsvFilter = state.doesNotEqual('MG');
const stateIsNoneOf: CsvFilter = state.isNoneOf(['MG', 'ES']);
const stateStartsWith: CsvFilter = state.startsWith('S');
const stateHasMatch: CsvFilter = state.hasMatch(/^(?:SP|RJ)$/);
void csv.rows(path, { where: stateEquals });
void csv.rows(path, { where: optionalFilter });
void csv.rows(path, { where: stateIsOneOf });
void csv.rows(path, { where: stateDoesNotEqual });
void csv.rows(path, { where: stateIsNoneOf });
void csv.rows(path, { where: stateStartsWith });
void csv.rows(path, { where: stateHasMatch });
void csv.rows(path, {
  where: csv.all(csv.column(1).startsWith('A'), csv.column(2).isOneOf(['SP', 'RJ'])),
});
void csv.rows(path, {
  where: csv.any(csv.column(1).startsWith('A'), csv.not(csv.column(2).equals('MG'))),
});
void csv.rows(path, { compression: 'gzip' });
void csv.rows(path, { compression: 'auto' });
void csv.rows(path, { compression: { entry: 'data.csv', format: 'zip' } });
void csv.rows(path, { delimiter: 'auto' });
void csv.batches(path, { compression: 'brotli' });
void csv.batches(path, { delimiter: 'auto' });
void csv.count(path, { compression: 'zstd' });
void csv.count(path, { delimiter: 'auto' });
void parallelCount(path, { workerCount: 2, where: stateIsOneOf });
void parallelCount(path, { workerCount: 2, where: stateHasMatch });
void parallelRows(path, {
  workerCount: 2,
  where: csv.all(csv.column(1).startsWith('A'), csv.column(2).equals('SP')),
});
using filteredPool = workerPool(path, {
  workerCount: 2,
  where: csv.all(csv.column(1).startsWith('A'), csv.column(2).equals('SP')),
});
void filteredPool.count();
void filteredPool.rows();

// @ts-expect-error high-level where filters must use csv.column()
void csv.rows(path, { where: { column: 1, equals: 'SP' } });

// @ts-expect-error filter columns expose condition methods, not descriptor fields
void state.in(['SP']);

// @ts-expect-error selected filter columns are immutable
state.equals = () => stateEquals;

// @ts-expect-error hasMatch requires a RegExp
void state.hasMatch('SP');

// @ts-expect-error opaque filters cannot be constructed as object literals
const forgedFilter: CsvFilter = {};
void forgedFilter;

// @ts-expect-error csv.any requires at least one filter
void csv.any();

// @ts-expect-error csv.not requires exactly one filter
void csv.not(stateEquals, stateIsOneOf);

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
void csv.rows(path, { strict: dynamicStrict, where: stateEquals });

// @ts-expect-error direct parallel count requires workerCount
void parallelCount(path, {});

// @ts-expect-error direct parallel count does not support strict mode
void parallelCount(path, { strict: true, workerCount: 2 });

// @ts-expect-error strict count does not support filters
void csv.count(path, { strict: true, where: stateEquals });

// @ts-expect-error strict rows do not support filters
void csv.rows(path, { strict: true, where: stateEquals });

// @ts-expect-error columns and selectedColumns are mutually exclusive
void csv.rows(path, { columns: [0] as const, selectedColumns: [1] as const });

// @ts-expect-error row views do not support workers
void csv.withRowViews(path, { workerCount: 2 }, () => {});

void csv.withRowViews(path, { where: stateIsOneOf }, () => {});

// @ts-expect-error batches do not support workers
void csv.batches(path, { workerCount: 2 });

void csv.batches(path, { where: stateIsOneOf });

// @ts-expect-error columnar batches do not support strict selected columns
void csv.withColumnarBatches(path, { columns: [0] as const, strict: true }, () => {});

// @ts-expect-error count() with workers does not support strict mode
void csv.count(path, { workerCount: 2, strict: true });

// @ts-expect-error count() with strict mode does not support filters
void csv.count(path, { strict: true, where: stateIsOneOf });

// @ts-expect-error workerPool requires explicit worker options
void workerPool(path);

void workerPool(path, { workerCount: 2, where: stateIsOneOf });

// @ts-expect-error workerPool does not support strict mode
void workerPool(path, { strict: true, workerCount: 2 });
