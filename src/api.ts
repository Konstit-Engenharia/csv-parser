import { createReadStream } from 'node:fs';
import { NativeCsvRowView } from './batches.ts';
import type {
  NativeCsvBatch,
  NativeCsvColumnStatsBatch,
  NativeCsvDictionaryBatch,
  NativeCsvGroupByCountBatch,
} from './batches.ts';
import {
  findCsvSafeShards as findCsvSafeShardsNative,
  findCsvSafeSplitOffsets as findCsvSafeSplitOffsetsNative,
} from './files.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import { NativeCsvParser } from './parser.ts';
import {
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from './strict-schema.ts';
import { CsvStringCache } from './string-cache.ts';
import type {
  CsvAggregateOptions,
  CsvApiFileOptions,
  CsvBatchesOptions,
  CsvColumnarBatchCallback,
  CsvColumnarBatchOptions,
  CsvColumnarBatchView,
  CsvColumns,
  CsvColumnSelection,
  CsvCountOptions,
  CsvDictionaryOptions,
  CsvEncoding,
  CsvFieldValue,
  CsvFileOptions,
  CsvParallelAggregateOptions,
  CsvParallelCountOptions,
  CsvParallelRowsOptions,
  CsvParseOptions,
  CsvParserOptions,
  CsvProjectedRow,
  CsvRowsOptions,
  CsvRowView,
  CsvRowViewCallback,
  CsvRowViewsOptions,
  CsvShard,
  CsvWhereEqualsFilter,
  CsvWhereFilter,
  CsvWhereInFilter,
  CsvWhereStartsWithFilter,
  CsvWorkerPoolOptions,
} from './types.ts';
import {
  parallelColumnStats,
  parallelGroupByCount,
  parallelMultiColumnStats,
} from './worker-aggregates.ts';
import { parallelCount } from './worker-count.ts';
import {
  createWorkerPool,
  CsvWorkerPool,
} from './worker-pool.ts';
import { parallelRows } from './worker-rows.ts';

type CsvWhereState = 'none' | 'equals' | 'in' | 'startsWith';
type CsvRowsWhereState = 'none' | 'equals';
type CsvSelectedColumnsState = CsvColumns | undefined;

type CsvWhereStateFromFilter<TWhere> = [Exclude<TWhere, undefined>] extends [never] ? 'none'
  : Exclude<TWhere, undefined> extends CsvWhereEqualsFilter ? 'equals'
  : Exclude<TWhere, undefined> extends CsvWhereInFilter ? 'in'
  : Exclude<TWhere, undefined> extends CsvWhereStartsWithFilter ? 'startsWith'
  : CsvWhereState;

type CsvSelectedColumnsFromOptions<TOptions extends CsvApiFileOptions> = TOptions extends { columns: infer TColumns extends CsvColumns; }
  ? TColumns
  : TOptions extends { selectedColumns: infer TColumns extends CsvColumns; } ? TColumns
  : undefined;

type CsvHasColumns<TSelectedColumns extends CsvSelectedColumnsState> = [TSelectedColumns] extends [undefined] ? false : true;

type CsvWorkersStateFromOptions<TOptions extends CsvApiFileOptions> = TOptions extends { workerCount: infer TWorkerCount extends number; }
  ? TWorkerCount extends 0 | 1 ? false
  : true
  : false;

type CsvStrictStateFromOptions<TOptions extends CsvApiFileOptions> = TOptions extends { strict: infer TStrict extends boolean; } ? TStrict
  : false;

type CsvBuilderFromOptions<TOptions extends CsvApiFileOptions> = CsvFileBuilder<
  TOptions extends { where: infer TWhere; } ? CsvWhereStateFromFilter<TWhere> : 'none',
  CsvSelectedColumnsFromOptions<TOptions>,
  CsvStrictStateFromOptions<TOptions>,
  CsvWorkersStateFromOptions<TOptions>
>;

type CsvPoolFromBuilder<TSelectedColumns extends CsvSelectedColumnsState> = CsvWorkerPool<TSelectedColumns>;

type CsvRowsCapableBuilder<
  TWhere extends CsvWhereState,
  TSelectedColumns extends CsvSelectedColumnsState,
  TStrict extends boolean,
  TWorkers extends boolean,
> = TWhere extends 'none' ? TWorkers extends true ? TStrict extends false ? CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>
    : never
  : CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>
  : TWhere extends 'equals' ? TStrict extends false ? CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>
    : never
  : never;

type CsvBuilderOperationOptions<TOptions> = TOptions extends unknown ? Omit<TOptions, 'strict' | 'workerCount' | 'where'> : never;

type CsvBatchesCapableBuilder<
  TWhere extends CsvWhereState,
  TSelectedColumns extends CsvSelectedColumnsState,
  TStrict extends boolean,
> = CsvRowsCapableBuilder<TWhere, TSelectedColumns, TStrict, false>;

type CsvRowViewsCapableBuilder<
  TWhere extends CsvWhereState,
  TSelectedColumns extends CsvSelectedColumnsState,
  TStrict extends boolean,
> = CsvRowsCapableBuilder<TWhere, TSelectedColumns, TStrict, false>;

type CsvColumnarCapableBuilder<
  TWhere extends CsvWhereState,
  TSelectedColumns extends CsvSelectedColumnsState,
  TStrict extends boolean,
> = TWhere extends CsvRowsWhereState ? TStrict extends false ? CsvFileBuilder<TWhere, TSelectedColumns, TStrict, false>
  : TWhere extends 'none' ? CsvHasColumns<TSelectedColumns> extends true ? never
    : CsvFileBuilder<TWhere, TSelectedColumns, TStrict, false>
  : never
  : never;

type CsvCountCapableBuilder<
  TWhere extends CsvWhereState,
  TSelectedColumns extends CsvSelectedColumnsState,
  TStrict extends boolean,
  TWorkers extends boolean,
> = TWhere extends 'none' ? TWorkers extends true ? TStrict extends false ? CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>
    : never
  : CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>
  : TStrict extends false ? CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>
  : never;

type CsvWorkerPoolCapableBuilder<
  TWhere extends CsvWhereState,
  TSelectedColumns extends CsvSelectedColumnsState,
  TStrict extends boolean,
> = TWhere extends CsvRowsWhereState ? TStrict extends false ? CsvFileBuilder<TWhere, TSelectedColumns, TStrict, true>
  : never
  : never;

type CsvDictionaryCapableBuilder<TSelectedColumns extends CsvSelectedColumnsState> = CsvFileBuilder<
  'none',
  TSelectedColumns,
  false,
  false
>;

type CsvAggregateCapableBuilder<
  TSelectedColumns extends CsvSelectedColumnsState,
  TWorkers extends boolean,
> = CsvFileBuilder<'none', TSelectedColumns, false, TWorkers>;

export class CsvFileBuilder<
  TWhere extends CsvWhereState = 'none',
  TSelectedColumns extends CsvSelectedColumnsState = undefined,
  TStrict extends boolean = false,
  TWorkers extends boolean = false,
> {
  declare readonly __state:
    & { where: TWhere; }
    & { selectedColumns: TSelectedColumns; }
    & { strict: TStrict; }
    & { workers: TWorkers; };
  readonly #path: string;
  readonly #options: CsvApiFileOptions;

  constructor(path: string, options: CsvApiFileOptions = {}) {
    this.#path = path;
    this.#options = { ...options };
  }

  delimiter(delimiter: string): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ delimiter });
  }

  encoding(encoding: CsvEncoding): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ encoding });
  }

  chunkSize(chunkSize: number): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ chunkSize });
  }

  workers(workerCount: number): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, true> {
    if (!Number.isInteger(workerCount) || workerCount <= 1) {
      throw new RangeError(`workers requires workerCount > 1: ${String(workerCount)}`);
    }
    return this.#clone<TWhere, TSelectedColumns, TStrict, true>({ workerCount });
  }

  pool(this: CsvWorkerPoolCapableBuilder<TWhere, TSelectedColumns, TStrict>): CsvPoolFromBuilder<TSelectedColumns> {
    return createWorkerPool(this.#path, this.#options) as CsvPoolFromBuilder<TSelectedColumns>;
  }

  strict(): CsvFileBuilder<TWhere, TSelectedColumns, true, TWorkers>;
  strict<TEnabled extends boolean>(
    enabled: TEnabled,
  ): CsvFileBuilder<TWhere, TSelectedColumns, TEnabled, TWorkers>;
  strict(enabled = true): CsvFileBuilder<TWhere, TSelectedColumns, boolean, TWorkers> {
    return this.#clone<TWhere, TSelectedColumns, boolean, TWorkers>({ strict: enabled });
  }

  select<TColumns extends CsvColumns>(columns: TColumns): CsvFileBuilder<TWhere, TColumns, TStrict, TWorkers> {
    return this.#clone<TWhere, TColumns, TStrict, TWorkers>({ columns });
  }

  fixedColumns(count: number): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ fixedColumns: count });
  }

  trustedFixedColumns(count: number): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ trustedFixedColumns: count });
  }

  expectedHeaders(headers: readonly string[]): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ expectedHeaders: headers });
  }

  requireHeader(required = true): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ requireHeader: required });
  }

  minDataRows(rows: number): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({ minDataRows: rows });
  }

  where(where: CsvWhereEqualsFilter): CsvFileBuilder<'equals', TSelectedColumns, TStrict, TWorkers>;
  where(where: CsvWhereInFilter): CsvFileBuilder<'in', TSelectedColumns, TStrict, TWorkers>;
  where(where: CsvWhereStartsWithFilter): CsvFileBuilder<'startsWith', TSelectedColumns, TStrict, TWorkers>;
  where(where: CsvWhereFilter): CsvFileBuilder<CsvWhereState, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone<CsvWhereState, TSelectedColumns, TStrict, TWorkers>({ where });
  }

  whereEquals(column: number, value: CsvFieldValue): CsvFileBuilder<'equals', TSelectedColumns, TStrict, TWorkers> {
    return this.#clone<'equals', TSelectedColumns, TStrict, TWorkers>({ where: { column, equals: value } });
  }

  whereIn(column: number, values: readonly CsvFieldValue[]): CsvFileBuilder<'in', TSelectedColumns, TStrict, TWorkers> {
    return this.#clone<'in', TSelectedColumns, TStrict, TWorkers>({ where: { column, in: values } });
  }

  whereStartsWith(column: number, prefix: CsvFieldValue): CsvFileBuilder<'startsWith', TSelectedColumns, TStrict, TWorkers> {
    return this.#clone<'startsWith', TSelectedColumns, TStrict, TWorkers>({ where: { column, startsWith: prefix } });
  }

  stringCache(columns: CsvColumns, maxEntriesPerColumn?: number): CsvFileBuilder<TWhere, TSelectedColumns, TStrict, TWorkers> {
    return this.#clone({
      stringCache: {
        columns,
        maxEntriesPerColumn,
      },
    });
  }

  rows<TColumns extends CsvColumns | undefined = TSelectedColumns>(
    this: CsvRowsCapableBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>,
    options: CsvBuilderOperationOptions<CsvRowsOptions<TColumns>> = {},
  ): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
    return rows(this.#path, mergeRowsOptions(this.#options, options as CsvRowsOptions<TColumns>));
  }

  batches(
    this: CsvBatchesCapableBuilder<TWhere, TSelectedColumns, TStrict>,
    options: CsvBuilderOperationOptions<CsvBatchesOptions> = {},
  ): AsyncGenerator<NativeCsvBatch, void> {
    return batches(this.#path, mergeBatchesOptions(this.#options, options as CsvBatchesOptions));
  }

  withBatches(
    this: CsvBatchesCapableBuilder<TWhere, TSelectedColumns, TStrict>,
    callback: (batch: NativeCsvBatch) => void | Promise<void>,
    options: CsvBuilderOperationOptions<CsvBatchesOptions> = {},
  ): Promise<void> {
    return withBatches(this.#path, mergeBatchesOptions(this.#options, options as CsvBatchesOptions), callback);
  }

  forEachColumnarBatches<TColumns extends CsvColumns | undefined = TSelectedColumns>(
    this: CsvColumnarCapableBuilder<TWhere, TSelectedColumns, TStrict>,
    callback: CsvColumnarBatchCallback<NoInfer<TColumns>>,
    options: CsvBuilderOperationOptions<CsvColumnarBatchOptions<TColumns>> & CsvColumnSelection<TColumns> = {} as
      & CsvBuilderOperationOptions<CsvColumnarBatchOptions<TColumns>>
      & CsvColumnSelection<TColumns>,
  ): Promise<void> {
    return forEachColumnarBatches(
      this.#path,
      mergeColumnarBatchOptions(this.#options, options as CsvColumnarBatchOptions<TColumns>),
      callback,
    );
  }

  withColumnarBatches<TColumns extends CsvColumns | undefined = TSelectedColumns>(
    this: CsvColumnarCapableBuilder<TWhere, TSelectedColumns, TStrict>,
    callback: CsvColumnarBatchCallback<NoInfer<TColumns>>,
    options: CsvBuilderOperationOptions<CsvColumnarBatchOptions<TColumns>> & CsvColumnSelection<TColumns> = {} as
      & CsvBuilderOperationOptions<CsvColumnarBatchOptions<TColumns>>
      & CsvColumnSelection<TColumns>,
  ): Promise<void> {
    return forEachColumnarBatches(
      this.#path,
      mergeColumnarBatchOptions(this.#options, options as CsvColumnarBatchOptions<TColumns>),
      callback,
    );
  }

  forEachRowViews<TColumns extends CsvColumns | undefined = TSelectedColumns>(
    this: CsvRowViewsCapableBuilder<TWhere, TSelectedColumns, TStrict>,
    callback: CsvRowViewCallback<TColumns>,
    options: CsvBuilderOperationOptions<CsvRowViewsOptions<TColumns>> = {},
  ): Promise<void> {
    return forEachRowViews(this.#path, mergeRowViewsOptions(this.#options, options as CsvRowViewsOptions<TColumns>), callback);
  }

  withRowViews<TColumns extends CsvColumns | undefined = TSelectedColumns>(
    this: CsvRowViewsCapableBuilder<TWhere, TSelectedColumns, TStrict>,
    callback: CsvRowViewCallback<TColumns>,
    options: CsvBuilderOperationOptions<CsvRowViewsOptions<TColumns>> = {},
  ): Promise<void> {
    return forEachRowViews(this.#path, mergeRowViewsOptions(this.#options, options as CsvRowViewsOptions<TColumns>), callback);
  }

  count(
    this: CsvCountCapableBuilder<TWhere, TSelectedColumns, TStrict, TWorkers>,
    options: CsvBuilderOperationOptions<CsvCountOptions> = {},
  ): Promise<number> {
    return count(this.#path, mergeCountOptions(this.#options, options as CsvCountOptions));
  }

  splitOffsets(shardCount: number, options: CsvFileOptions = {}): number[] {
    const merged = mergeOptions(this.#options, options);
    return findCsvSafeSplitOffsetsNative(this.#path, shardCount, merged.delimiter ?? ',');
  }

  shards(shardCount: number, options: CsvFileOptions = {}): CsvShard[] {
    const merged = mergeOptions(this.#options, options);
    return findCsvSafeShardsNative(this.#path, shardCount, merged.delimiter ?? ',');
  }

  dictionary(
    this: CsvDictionaryCapableBuilder<TSelectedColumns>,
    column: number,
    options: CsvBuilderOperationOptions<CsvDictionaryOptions> = {},
  ): AsyncGenerator<NativeCsvDictionaryBatch, void> {
    return dictionary(this.#path, column, mergeDictionaryOptions(this.#options, options as CsvDictionaryOptions));
  }

  groupByCount(
    this: CsvAggregateCapableBuilder<TSelectedColumns, TWorkers>,
    column: number,
    options: CsvBuilderOperationOptions<CsvAggregateOptions> = {},
  ): Promise<NativeCsvGroupByCountBatch> {
    return groupByCount(this.#path, column, mergeAggregateOptions(this.#options, options as CsvAggregateOptions));
  }

  columnStats(
    this: CsvAggregateCapableBuilder<TSelectedColumns, TWorkers>,
    column: number,
    options: CsvBuilderOperationOptions<CsvAggregateOptions> = {},
  ): Promise<NativeCsvColumnStatsBatch> {
    return columnStats(this.#path, column, mergeAggregateOptions(this.#options, options as CsvAggregateOptions));
  }

  multiColumnStats(
    this: CsvAggregateCapableBuilder<TSelectedColumns, TWorkers>,
    columns: CsvColumns,
    options: CsvBuilderOperationOptions<CsvAggregateOptions> = {},
  ): Promise<NativeCsvColumnStatsBatch[]> {
    return multiColumnStats(this.#path, columns, mergeAggregateOptions(this.#options, options as CsvAggregateOptions));
  }

  #clone<
    TNextWhere extends CsvWhereState = TWhere,
    TNextSelectedColumns extends CsvSelectedColumnsState = TSelectedColumns,
    TNextStrict extends boolean = TStrict,
    TNextWorkers extends boolean = TWorkers,
  >(override: CsvApiFileOptions): CsvFileBuilder<TNextWhere, TNextSelectedColumns, TNextStrict, TNextWorkers> {
    return new CsvFileBuilder<TNextWhere, TNextSelectedColumns, TNextStrict, TNextWorkers>(
      this.#path,
      mergeOptions(this.#options, override),
    );
  }
}

export function file(path: string): CsvFileBuilder;
export function file<TOptions extends CsvApiFileOptions>(path: string, options: TOptions): CsvBuilderFromOptions<TOptions>;
export function file(path: string, options: CsvApiFileOptions = {}): CsvFileBuilder {
  return new CsvFileBuilder(path, options);
}

/**
 * Parse one in-memory chunk into materialized rows.
 *
 * Use this when you already own buffering and still want the high-level row API.
 * Accepts only single-thread row options, so `where` is limited to `where.equals`
 * and `workerCount` is intentionally unavailable.
 */
export async function parse<TColumns extends CsvColumns | undefined = undefined>(
  buffer: NodeJS.TypedArray | DataView,
  options: CsvParseOptions<TColumns> = {},
): Promise<CsvProjectedRow<TColumns>[]> {
  rejectFilteredStrictSchema(options);
  const parser = new NativeCsvParser(toParserOptions(options));
  const validator = strictSchemaValidator(options);
  const stringCache = createStringCache(options);
  try {
    const batch = writeMaterializeBatch(parser, buffer, options, true);
    try {
      validator?.validateBatch(batch);
      validator?.finish();
      return materializeRows(batch, options, stringCache);
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

/**
 * Stream materialized rows from a CSV file.
 *
 * Use this for the most direct high-level API. With `workerCount > 1`, the work
 * fans out across Bun workers. `where` is intentionally limited to `where.equals`
 * because the other predicates are currently count-only fast paths.
 */
export async function* rows<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowsOptions<TColumns> = {},
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  if ((options.workerCount ?? 1) > 1) {
    yield* parallelRows(path, options as CsvParallelRowsOptions<TColumns>);
    return;
  }

  rejectFilteredStrictSchema(options);
  const parser = new NativeCsvParser(toParserOptions(options));
  const validator = strictSchemaValidator(options);
  const stringCache = createStringCache(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = writeMaterializeBatch(parser, chunk as Buffer, options);
      if (batch.rowCount > 0) {
        try {
          validator?.validateBatch(batch);
          const values = materializeRows(batch, options, stringCache);
          if (values.length > 0) {
            yield values;
          }
        } finally {
          batch.close();
        }
      } else {
        batch.close();
      }
    }

    const batch = finishMaterializeBatch(parser, options);
    if (batch.rowCount > 0) {
      try {
        validator?.validateBatch(batch);
        validator?.finish();
        const values = materializeRows(batch, options, stringCache);
        if (values.length > 0) {
          yield values;
        }
      } finally {
        batch.close();
      }
    } else {
      validator?.finish();
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export { parallelRows };
export { CsvWorkerPool };
export { parallelColumnStats, parallelGroupByCount, parallelMultiColumnStats };

/**
 * Stream native batches with explicit lifetime control.
 *
 * Use this when you want low-allocation access to row views or byte ranges and
 * are comfortable closing each batch yourself.
 */
export async function* batches(path: string, options: CsvBatchesOptions = {}): AsyncGenerator<NativeCsvBatch, void> {
  ensureRowsWhereSupported(options.where);
  rejectFilteredStrictSchema(options);
  const parser = new NativeCsvParser(toParserOptions(options));
  const validator = strictSchemaValidator(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = writeRowsBatch(parser, chunk as Buffer, options);
      if (batch.rowCount > 0) {
        try {
          validator?.validateBatch(batch);
        } catch (error) {
          batch.close();
          throw error;
        }
        yield batch;
      } else {
        batch.close();
      }
    }

    const batch = finishRowsBatch(parser, options);
    if (batch.rowCount > 0) {
      try {
        validator?.validateBatch(batch);
        validator?.finish();
      } catch (error) {
        batch.close();
        throw error;
      }
      yield batch;
    } else {
      validator?.finish();
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function withBatches(
  path: string,
  options: CsvBatchesOptions,
  callback: (batch: NativeCsvBatch) => void | Promise<void>,
): Promise<void> {
  for await (const batch of batches(path, options)) {
    try {
      await callback(batch);
    } finally {
      batch.close();
    }
  }
}

/**
 * Stream reusable columnar batch views without materializing one JS string per field.
 *
 * When `columns` is defined, batch column indexes are relative to the projected
 * output order. This API is synchronous by design so the view can be safely reused.
 */
export function forEachColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void>;
export function forEachColumnarBatches(
  path: string,
  options: CsvColumnarBatchOptions | undefined,
  callback: CsvColumnarBatchCallback,
): Promise<void>;
export async function forEachColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvColumnarBatchOptions<TColumns> = {} as CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void> {
  ensureColumnarBatchesSupported(options);
  const scopedBatch = new ScopedCsvColumnarBatchView(selectedColumns(options) as TColumns);
  let batchIndex = 0;
  const parser = new NativeCsvParser(toParserOptions(options));
  const validator = strictSchemaValidator(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = writeColumnarBatch(parser, chunk as Buffer, options);
      if (batch.rowCount > 0) {
        try {
          validator?.validateBatch(batch);
          scopedBatch.bind(batch);
          try {
            const result = callback(scopedBatch, batchIndex);
            if (isPromiseLike(result)) {
              throw new TypeError('columnar batch callback must be synchronous');
            }
          } finally {
            scopedBatch.release();
          }
          ++batchIndex;
        } finally {
          batch.close();
        }
      } else {
        batch.close();
      }
    }

    const batch = finishColumnarBatch(parser, options);
    if (batch.rowCount > 0) {
      try {
        validator?.validateBatch(batch);
        validator?.finish();
        scopedBatch.bind(batch);
        try {
          const result = callback(scopedBatch, batchIndex);
          if (isPromiseLike(result)) {
            throw new TypeError('columnar batch callback must be synchronous');
          }
        } finally {
          scopedBatch.release();
        }
      } finally {
        batch.close();
      }
    } else {
      validator?.finish();
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export function withColumnarBatches<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvColumnarBatchOptions<TColumns>,
  callback: CsvColumnarBatchCallback<TColumns>,
): Promise<void>;
export function withColumnarBatches(
  path: string,
  options: CsvColumnarBatchOptions | undefined,
  callback: CsvColumnarBatchCallback,
): Promise<void> {
  return forEachColumnarBatches(path, options, callback);
}

/**
 * Stream reusable row views without materializing row arrays.
 *
 * `selectedColumns` on the row view is metadata only. Row accessors still use
 * physical CSV column indexes; use `row.getPhysical()` for explicit call sites.
 * This API is synchronous by design so the view can be safely reused.
 */
export function forEachRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void>;
export function forEachRowViews(
  path: string,
  options: CsvRowViewsOptions | undefined,
  callback: CsvRowViewCallback,
): Promise<void>;
export async function forEachRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowViewsOptions<TColumns> = {} as CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void> {
  ensureRowViewsSupported(options);
  const scopedRowView = new ScopedCsvRowView(selectedColumns(options) as TColumns);
  for await (const batch of batches(path, options)) {
    try {
      const rowCount = batch.rowCount;
      if (rowCount === 0) {
        continue;
      }
      const reusable = new NativeCsvRowView(batch.data(), batch.rowOffsets(), batch.fieldOffsets());
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        scopedRowView.bind(reusable.moveTo(rowIndex));
        try {
          const result = callback(scopedRowView, rowIndex);
          if (isPromiseLike(result)) {
            throw new TypeError('row view callback must be synchronous');
          }
        } finally {
          scopedRowView.release();
        }
      }
    } finally {
      batch.close();
    }
  }
}

export function withRowViews<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvRowViewsOptions<TColumns>,
  callback: CsvRowViewCallback<TColumns>,
): Promise<void>;
export function withRowViews(
  path: string,
  options: CsvRowViewsOptions | undefined,
  callback: CsvRowViewCallback,
): Promise<void> {
  return forEachRowViews(path, options, callback);
}

/**
 * Count rows without materializing them.
 *
 * Full filter support exists here because count has native fast paths for
 * `where.equals`, `where.in`, and `where.startsWith`.
 */
export async function count(path: string, options: CsvCountOptions = {}): Promise<number> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelCount(path, options as CsvParallelCountOptions);
  }

  rejectStrictSchemaUnsupported(options, 'count');
  const parser = new NativeCsvParser(toParserOptions(options));
  let total = 0;
  try {
    if (options.strict === true && options.where === undefined) {
      for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
        const batch = parser.writeBatch(chunk as Buffer);
        try {
          total += batch.rowCount;
        } finally {
          batch.close();
        }
      }
      const batch = parser.endBatch();
      try {
        total += batch.rowCount;
      } finally {
        batch.close();
      }
      return total;
    }

    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      total += writeCount(parser, chunk as Buffer, options.where);
    }
    total += finishCount(parser, options.where);
    return total;
  } finally {
    parser.close();
  }
}

export { parallelCount };

export function findCsvSafeSplitOffsets(path: string, shardCount: number, options: CsvFileOptions = {}): number[] {
  return findCsvSafeSplitOffsetsNative(path, shardCount, options.delimiter ?? ',');
}

export function findCsvSafeShards(path: string, shardCount: number, options: CsvFileOptions = {}): CsvShard[] {
  return findCsvSafeShardsNative(path, shardCount, options.delimiter ?? ',');
}

/**
 * Stream dictionary batches for one column.
 */
export async function* dictionary(
  path: string,
  column: number,
  options: CsvDictionaryOptions = {},
): AsyncGenerator<NativeCsvDictionaryBatch, void> {
  const parser = new NativeCsvParser(toParserOptions(options));
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = parser.writeDictionaryBatch(chunk as Buffer, column);
      if (batch.rowCount > 0) {
        yield batch;
      } else {
        batch.close();
      }
    }

    const batch = parser.endDictionaryBatch(column);
    if (batch.rowCount > 0) {
      yield batch;
    } else {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

/**
 * Aggregate value counts for one column.
 */
export async function groupByCount(
  path: string,
  column: number,
  options: CsvAggregateOptions = {},
): Promise<NativeCsvGroupByCountBatch> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelGroupByCount(path, column, options as CsvParallelAggregateOptions);
  }
  const parser = new NativeCsvParser(toParserOptions(options));
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeGroupByCount(chunk as Buffer, column);
    }
    return parser.endGroupByCount(column);
  } finally {
    parser.close();
  }
}

/**
 * Aggregate stats for one column.
 */
export async function columnStats(
  path: string,
  column: number,
  options: CsvAggregateOptions = {},
): Promise<NativeCsvColumnStatsBatch> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelColumnStats(path, column, options as CsvParallelAggregateOptions);
  }
  const parser = new NativeCsvParser(toParserOptions(options));
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeColumnStats(chunk as Buffer, column);
    }
    return parser.endColumnStats(column);
  } finally {
    parser.close();
  }
}

/**
 * Aggregate stats for multiple columns in one pass.
 */
export async function multiColumnStats(
  path: string,
  columns: CsvColumns,
  options: CsvAggregateOptions = {},
): Promise<NativeCsvColumnStatsBatch[]> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelMultiColumnStats(path, columns, options as CsvParallelAggregateOptions);
  }
  if (columns.length === 0) {
    return [];
  }

  const parser = new NativeCsvParser(toParserOptions(options));
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeMultiColumnStats(chunk as Buffer, columns);
    }
    return parser.endMultiColumnStats(columns);
  } finally {
    parser.close();
  }
}

export const stats = {
  column: columnStats,
  multi: multiColumnStats,
};

export function workerPool<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvWorkerPoolOptions<TColumns>,
): CsvWorkerPool<TColumns>;
/**
 * Create a reusable worker pool for repeated row and aggregate operations.
 *
 * Use this when one-off worker startup becomes noticeable across repeated calls.
 */
export function workerPool(path: string, options: CsvApiFileOptions): CsvWorkerPool {
  return createWorkerPool(path, options);
}

export const csv = {
  file,
  workerPool,
  parse,
  rows,
  parallelCount,
  parallelGroupByCount,
  parallelColumnStats,
  parallelMultiColumnStats,
  parallelRows,
  batches,
  withBatches,
  forEachColumnarBatches,
  withColumnarBatches,
  forEachRowViews,
  withRowViews,
  count,
  findCsvSafeSplitOffsets,
  findCsvSafeShards,
  dictionary,
  groupByCount,
  columnStats,
  multiColumnStats,
  stats,
};

function mergeOptions<TOptions extends CsvApiFileOptions>(base: CsvApiFileOptions, override: TOptions): TOptions {
  return mergeApiOptions(base, override) as TOptions;
}

function mergeRowsOptions<TColumns extends CsvColumns | undefined>(
  base: CsvApiFileOptions,
  override: CsvRowsOptions<TColumns>,
): CsvRowsOptions<TColumns> {
  return mergeApiOptions(base, override) as CsvRowsOptions<TColumns>;
}

function mergeBatchesOptions(base: CsvApiFileOptions, override: CsvBatchesOptions): CsvBatchesOptions {
  return mergeApiOptions(base, override) as CsvBatchesOptions;
}

function mergeRowViewsOptions<TColumns extends CsvColumns | undefined>(
  base: CsvApiFileOptions,
  override: CsvRowViewsOptions<TColumns>,
): CsvRowViewsOptions<TColumns> {
  return mergeApiOptions(base, override) as CsvRowViewsOptions<TColumns>;
}

function mergeColumnarBatchOptions<TColumns extends CsvColumns | undefined>(
  base: CsvApiFileOptions,
  override: CsvColumnarBatchOptions<TColumns>,
): CsvColumnarBatchOptions<TColumns> {
  return mergeApiOptions(base, override) as CsvColumnarBatchOptions<TColumns>;
}

function mergeCountOptions(base: CsvApiFileOptions, override: CsvCountOptions): CsvCountOptions {
  return mergeApiOptions(base, override) as CsvCountOptions;
}

function mergeDictionaryOptions(base: CsvApiFileOptions, override: CsvDictionaryOptions): CsvDictionaryOptions {
  return mergeApiOptions(base, override) as CsvDictionaryOptions;
}

function mergeAggregateOptions(base: CsvApiFileOptions, override: CsvAggregateOptions): CsvAggregateOptions {
  return mergeApiOptions(base, override) as CsvAggregateOptions;
}

function mergeApiOptions(base: CsvApiFileOptions, override: CsvApiFileOptions): CsvApiFileOptions {
  const merged = { ...base, ...override };
  if (override.columns !== undefined) {
    delete merged.selectedColumns;
  }
  if (override.selectedColumns !== undefined) {
    delete merged.columns;
  }
  return merged;
}

function toParserOptions(options: CsvApiFileOptions | CsvFileOptions): CsvParserOptions {
  const selectedColumns = 'columns' in options && options.columns !== undefined
    ? options.columns
    : options.selectedColumns;
  if ('columns' in options && options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use columns or selectedColumns, not both');
  }
  if ('trustedFixedColumns' in options && options.trustedFixedColumns !== undefined) {
    if (options.trusted !== undefined) {
      throw new Error('use trustedFixedColumns or trusted, not both');
    }
    if (options.fixedColumns !== undefined) {
      throw new Error('use trustedFixedColumns or fixedColumns, not both');
    }
    return {
      delimiter: options.delimiter,
      encoding: options.encoding,
      strict: options.strict,
      selectedColumns,
      trusted: {
        fixedColumns: options.trustedFixedColumns,
        noNewlinesInQuotes: true,
      },
    };
  }
  return {
    delimiter: options.delimiter,
    encoding: options.encoding,
    strict: options.strict,
    selectedColumns,
    fixedColumns: options.fixedColumns,
    trusted: options.trusted,
  };
}

function selectedColumns(options: CsvApiFileOptions): CsvColumns | undefined {
  if (options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use columns or selectedColumns, not both');
  }
  return options.columns ?? options.selectedColumns;
}

function materializeRows<TColumns extends CsvColumns | undefined>(
  batch: NativeCsvBatch,
  options: CsvApiFileOptions & { columns?: TColumns; },
  stringCache?: CsvStringCache,
): CsvProjectedRow<TColumns>[] {
  const columns = selectedColumns(options);
  if (usesProjectedMaterialization(options)) {
    if (stringCache !== undefined && columns !== undefined) {
      return materializeProjectedRows(batch, columns, stringCache) as CsvProjectedRow<TColumns>[];
    }
    return batch.rowsInto([]) as CsvProjectedRow<TColumns>[];
  }
  return batch.rowsInto([], columns, stringCache) as CsvProjectedRow<TColumns>[];
}

function materializeProjectedRows(batch: NativeCsvBatch, columns: CsvColumns, stringCache: CsvStringCache): string[][] {
  const rows: string[][] = [];
  rows.length = batch.rowCount;
  const projectedColumns = projectedColumnIndexes(columns);
  batch.scanColumns(projectedColumns, (rowIndex, ranges, data) => {
    const row: string[] = [];
    row.length = columns.length;
    for (let columnIndex = 0; columnIndex < columns.length; ++columnIndex) {
      const rangeIndex = columnIndex * 2;
      const start = ranges[rangeIndex] ?? -1;
      const end = ranges[rangeIndex + 1] ?? -1;
      row[columnIndex] = start === -1 || end === -1
        ? ''
        : stringCache.decode(data, start, end, columns[columnIndex] ?? 0);
    }
    rows[rowIndex] = row;
  });
  return rows;
}

function projectedColumnIndexes(columns: CsvColumns): CsvColumns {
  const projected: number[] = [];
  projected.length = columns.length;
  for (let index = 0; index < columns.length; ++index) {
    projected[index] = index;
  }
  return projected;
}

function createStringCache(options: CsvApiFileOptions): CsvStringCache | undefined {
  if (options.stringCache === undefined) {
    return undefined;
  }
  return new CsvStringCache(options.stringCache);
}

function usesProjectedMaterialization(options: CsvApiFileOptions): boolean {
  const where = options.where;
  if (where !== undefined) {
    if ('equals' in where) {
      return true;
    }
    ensureRowsWhereSupported(where);
  }
  return options.strict !== true && selectedColumns(options) !== undefined;
}

function writeRowsBatch(
  parser: NativeCsvParser,
  chunk: NodeJS.TypedArray | DataView,
  options: CsvApiFileOptions,
  final = false,
): NativeCsvBatch {
  const where = options.where;
  if (where !== undefined) {
    if ('equals' in where) {
      return parser.writeProjectedBatch(
        chunk,
        {
          selectedColumns: selectedColumns(options),
          equalsFilter: {
            column: where.column,
            value: where.equals,
          },
        },
        final,
      );
    }
    ensureRowsWhereSupported(where);
  }
  return parser.writeBatch(chunk, final);
}

function writeMaterializeBatch(
  parser: NativeCsvParser,
  chunk: NodeJS.TypedArray | DataView,
  options: CsvApiFileOptions,
  final = false,
): NativeCsvBatch {
  const columns = selectedColumns(options);
  const where = options.where;
  if (where !== undefined) {
    if ('equals' in where) {
      return parser.writeProjectedBatch(
        chunk,
        {
          selectedColumns: columns,
          equalsFilter: {
            column: where.column,
            value: where.equals,
          },
        },
        final,
      );
    }
    ensureRowsWhereSupported(where);
  }
  if (options.strict !== true && columns !== undefined) {
    return parser.writeProjectedBatch(chunk, { selectedColumns: columns }, final);
  }
  return parser.writeBatch(chunk, final);
}

function writeColumnarBatch(
  parser: NativeCsvParser,
  chunk: NodeJS.TypedArray | DataView,
  options: CsvApiFileOptions,
  final = false,
): NativeCsvBatch {
  const columns = selectedColumns(options);
  const where = options.where;
  if (where !== undefined) {
    if ('equals' in where) {
      return parser.writeProjectedBatch(
        chunk,
        {
          selectedColumns: columns,
          equalsFilter: {
            column: where.column,
            value: where.equals,
          },
        },
        final,
      );
    }
    ensureRowsWhereSupported(where);
  }
  if (columns !== undefined) {
    return parser.writeProjectedBatch(chunk, { selectedColumns: columns }, final);
  }
  return parser.writeBatch(chunk, final);
}

function finishRowsBatch(parser: NativeCsvParser, options: CsvApiFileOptions): NativeCsvBatch {
  const where = options.where;
  if (where !== undefined) {
    if ('equals' in where) {
      return parser.endProjectedBatch({
        selectedColumns: selectedColumns(options),
        equalsFilter: {
          column: where.column,
          value: where.equals,
        },
      });
    }
    ensureRowsWhereSupported(where);
  }
  return parser.endBatch();
}

function finishMaterializeBatch(parser: NativeCsvParser, options: CsvApiFileOptions): NativeCsvBatch {
  const columns = selectedColumns(options);
  const where = options.where;
  if (where !== undefined) {
    if ('equals' in where) {
      return parser.endProjectedBatch({
        selectedColumns: columns,
        equalsFilter: {
          column: where.column,
          value: where.equals,
        },
      });
    }
    ensureRowsWhereSupported(where);
  }
  if (options.strict !== true && columns !== undefined) {
    return parser.endProjectedBatch({ selectedColumns: columns });
  }
  return parser.endBatch();
}

function finishColumnarBatch(parser: NativeCsvParser, options: CsvApiFileOptions): NativeCsvBatch {
  const columns = selectedColumns(options);
  const where = options.where;
  if (where !== undefined) {
    if ('equals' in where) {
      return parser.endProjectedBatch({
        selectedColumns: columns,
        equalsFilter: {
          column: where.column,
          value: where.equals,
        },
      });
    }
    ensureRowsWhereSupported(where);
  }
  if (columns !== undefined) {
    return parser.endProjectedBatch({ selectedColumns: columns });
  }
  return parser.endBatch();
}

function ensureRowsWhereSupported(where: CsvWhereFilter | undefined): void {
  if (where === undefined || 'equals' in where) {
    return;
  }
  throw new Error(
    'rows() supports only where.equals; use count() for where.in or where.startsWith, or pre-filter inside withBatches()/withRowViews()',
  );
}

function ensureRowViewsSupported(options: CsvApiFileOptions): void {
  if ((options.workerCount ?? 1) > 1) {
    throw new Error(
      'row view callbacks do not support workerCount; use rows()/parallelRows() for materialized rows or withBatches() for low-level streaming',
    );
  }
}

function ensureColumnarBatchesSupported(options: CsvApiFileOptions): void {
  ensureRowViewsSupported(options);
  if (options.strict === true && selectedColumns(options) !== undefined) {
    throw new Error(
      'columnar batch callbacks do not support strict selectedColumns; use rows() for projected validation or withBatches() for manual low-level handling',
    );
  }
}

function rejectFilteredStrictSchema(options: CsvApiFileOptions): void {
  if (options.where !== undefined) {
    rejectStrictSchemaUnsupported(options, 'filtered rows');
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}

class ScopedCsvRowView<TSelectedColumns extends CsvColumns | undefined = undefined> implements CsvRowView<TSelectedColumns> {
  readonly #selectedColumns: TSelectedColumns;
  #rowView: NativeCsvRowView | null = null;

  constructor(selectedColumns: TSelectedColumns) {
    this.#selectedColumns = selectedColumns;
  }

  bind(rowView: NativeCsvRowView): this {
    this.#rowView = rowView;
    return this;
  }

  release(): void {
    this.#rowView = null;
  }

  get rowIndex(): number {
    return this.#requireRowView().rowIndex;
  }

  get fieldCount(): number {
    return this.#requireRowView().fieldCount;
  }

  get selectedColumns(): TSelectedColumns {
    return this.#selectedColumns;
  }

  fieldRange(columnIndex: number) {
    return this.#requireRowView().fieldRange(columnIndex);
  }

  range(columnIndex: number) {
    return this.#requireRowView().range(columnIndex);
  }

  fieldBytes(columnIndex: number) {
    return this.#requireRowView().fieldBytes(columnIndex);
  }

  bytes(columnIndex: number) {
    return this.#requireRowView().bytes(columnIndex);
  }

  fieldBuffer(columnIndex: number) {
    return this.#requireRowView().fieldBuffer(columnIndex);
  }

  buffer(columnIndex: number) {
    return this.#requireRowView().buffer(columnIndex);
  }

  fieldString(columnIndex: number) {
    return this.#requireRowView().fieldString(columnIndex);
  }

  getPhysical(columnIndex: number) {
    return this.#requireRowView().getPhysical(columnIndex);
  }

  get(columnIndex: number) {
    return this.#requireRowView().get(columnIndex);
  }

  pickPhysical(columns: CsvColumns): string[] {
    return this.#requireRowView().pickPhysical(columns);
  }

  pick(columns: CsvColumns): string[] {
    return this.#requireRowView().pick(columns);
  }

  #requireRowView(): NativeCsvRowView {
    if (this.#rowView === null) {
      throw new Error('row view is only valid during row view callback');
    }
    return this.#rowView;
  }
}

class ScopedCsvColumnarBatchView<TSelectedColumns extends CsvColumns | undefined = undefined>
  implements CsvColumnarBatchView<TSelectedColumns> {
  readonly #selectedColumns: TSelectedColumns;
  #batch: NativeCsvBatch | null = null;

  constructor(selectedColumns: TSelectedColumns) {
    this.#selectedColumns = selectedColumns;
  }

  bind(batch: NativeCsvBatch): this {
    this.#batch = batch;
    return this;
  }

  release(): void {
    this.#batch = null;
  }

  get rowCount(): number {
    return this.#requireBatch().rowCount;
  }

  get totalFields(): number {
    return this.#requireBatch().totalFields;
  }

  get dataLength(): number {
    return this.#requireBatch().dataLength;
  }

  get selectedColumns(): TSelectedColumns {
    return this.#selectedColumns;
  }

  data(): Buffer {
    return this.#requireBatch().data();
  }

  dataView(): Uint8Array {
    return this.#requireBatch().dataView();
  }

  rowOffsets(): Uint32Array {
    return this.#requireBatch().rowOffsets();
  }

  fieldOffsets(): Uint32Array {
    return this.#requireBatch().fieldOffsets();
  }

  rowFieldCount(rowIndex: number): number {
    return this.#requireBatch().rowFieldCount(rowIndex);
  }

  fieldRange(rowIndex: number, columnIndex: number) {
    return this.#requireBatch().fieldRange(rowIndex, columnIndex);
  }

  fieldBytes(rowIndex: number, columnIndex: number) {
    return this.#requireBatch().fieldBytes(rowIndex, columnIndex);
  }

  fieldBuffer(rowIndex: number, columnIndex: number) {
    return this.#requireBatch().fieldBuffer(rowIndex, columnIndex);
  }

  forEachColumnRange(
    columnIndex: number,
    callback: (rowIndex: number, start: number, end: number) => void,
    startRow?: number,
    endRow?: number,
  ) {
    return this.#requireBatch().forEachColumnRange(columnIndex, callback, startRow, endRow);
  }

  forEachColumnBytes(columnIndex: number, callback: (rowIndex: number, bytes: Uint8Array) => void, startRow?: number, endRow?: number) {
    return this.#requireBatch().forEachColumnBytes(columnIndex, callback, startRow, endRow);
  }

  scanColumns(
    columns: CsvColumns,
    callback: (rowIndex: number, ranges: Int32Array, data: Buffer) => void,
    startRow?: number,
    endRow?: number,
  ) {
    return this.#requireBatch().scanColumns(columns, callback, startRow, endRow);
  }

  #requireBatch(): NativeCsvBatch {
    if (this.#batch === null) {
      throw new Error('columnar batch view is only valid during columnar batch callback');
    }
    return this.#batch;
  }
}

function writeCount(parser: NativeCsvParser, chunk: NodeJS.TypedArray | DataView, where: CsvWhereFilter | undefined): number {
  if (where === undefined) {
    return parser.writeCount(chunk);
  }
  if ('equals' in where) {
    return parser.writeCountWhereEquals(chunk, { column: where.column, value: where.equals });
  }
  if ('in' in where) {
    return parser.writeCountWhereIn(chunk, { column: where.column, values: where.in });
  }
  return parser.writeCountWhereStartsWith(chunk, { column: where.column, prefix: where.startsWith });
}

function finishCount(parser: NativeCsvParser, where: CsvWhereFilter | undefined): number {
  if (where === undefined) {
    return parser.endCount();
  }
  if ('equals' in where) {
    return parser.endCountWhereEquals({ column: where.column, value: where.equals });
  }
  if ('in' in where) {
    return parser.endCountWhereIn({ column: where.column, values: where.in });
  }
  return parser.endCountWhereStartsWith({ column: where.column, prefix: where.startsWith });
}
