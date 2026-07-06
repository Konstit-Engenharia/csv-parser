import { createReadStream } from 'node:fs';
import {
  NativeCsvRowView,
} from './batches.ts';
import type {
  NativeCsvBatch,
  NativeCsvColumnStatsBatch,
  NativeCsvDictionaryBatch,
  NativeCsvGroupByCountBatch,
} from './batches.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import { NativeCsvParser } from './parser.ts';
import {
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from './strict-schema.ts';
import type {
  CsvApiFileOptions,
  CsvColumnarBatchCallback,
  CsvColumnarBatchView,
  CsvColumns,
  CsvEncoding,
  CsvFieldValue,
  CsvFileOptions,
  CsvRowView,
  CsvRowViewCallback,
  CsvParserOptions,
  CsvProjectedRow,
  CsvShard,
  CsvWhereFilter,
} from './types.ts';
import {
  findCsvSafeShards as findCsvSafeShardsNative,
  findCsvSafeSplitOffsets as findCsvSafeSplitOffsetsNative,
} from './files.ts';
import { parallelCount } from './worker-count.ts';
import {
  parallelColumnStats,
  parallelGroupByCount,
  parallelMultiColumnStats,
} from './worker-aggregates.ts';
import {
  createWorkerPool,
  CsvWorkerPool,
} from './worker-pool.ts';
import { parallelRows } from './worker-rows.ts';

export class CsvFileBuilder {
  readonly #path: string;
  readonly #options: CsvApiFileOptions;

  constructor(path: string, options: CsvApiFileOptions = {}) {
    this.#path = path;
    this.#options = { ...options };
  }

  delimiter(delimiter: string): this {
    this.#options.delimiter = delimiter;
    return this;
  }

  encoding(encoding: CsvEncoding): this {
    this.#options.encoding = encoding;
    return this;
  }

  chunkSize(chunkSize: number): this {
    this.#options.chunkSize = chunkSize;
    return this;
  }

  workers(workerCount: number): this {
    this.#options.workerCount = workerCount;
    return this;
  }

  pool(): CsvWorkerPool {
    return createWorkerPool(this.#path, this.#options);
  }

  strict(enabled = true): this {
    this.#options.strict = enabled;
    return this;
  }

  select(columns: CsvColumns): this {
    this.#options.columns = columns;
    return this;
  }

  fixedColumns(count: number): this {
    this.#options.fixedColumns = count;
    return this;
  }

  trustedFixedColumns(count: number): this {
    this.#options.trustedFixedColumns = count;
    return this;
  }

  expectedHeaders(headers: readonly string[]): this {
    this.#options.expectedHeaders = headers;
    return this;
  }

  requireHeader(required = true): this {
    this.#options.requireHeader = required;
    return this;
  }

  minDataRows(rows: number): this {
    this.#options.minDataRows = rows;
    return this;
  }

  where(where: CsvWhereFilter): this {
    this.#options.where = where;
    return this;
  }

  whereEquals(column: number, value: CsvFieldValue): this {
    this.#options.where = { column, equals: value };
    return this;
  }

  whereIn(column: number, values: readonly CsvFieldValue[]): this {
    this.#options.where = { column, in: values };
    return this;
  }

  whereStartsWith(column: number, prefix: CsvFieldValue): this {
    this.#options.where = { column, startsWith: prefix };
    return this;
  }

  rows<TColumns extends CsvColumns | undefined = undefined>(
    options: CsvApiFileOptions & { columns?: TColumns; } = {},
  ): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
    return rows(this.#path, mergeOptions(this.#options, options));
  }

  batches(options: CsvApiFileOptions = {}): AsyncGenerator<NativeCsvBatch, void> {
    return batches(this.#path, mergeOptions(this.#options, options));
  }

  withBatches(
    callback: (batch: NativeCsvBatch) => void | Promise<void>,
    options: CsvApiFileOptions = {},
  ): Promise<void> {
    return withBatches(this.#path, mergeOptions(this.#options, options), callback);
  }

  forEachColumnarBatches(
    callback: CsvColumnarBatchCallback,
    options: CsvApiFileOptions = {},
  ): Promise<void> {
    return forEachColumnarBatches(this.#path, mergeOptions(this.#options, options), callback);
  }

  withColumnarBatches(
    callback: CsvColumnarBatchCallback,
    options: CsvApiFileOptions = {},
  ): Promise<void> {
    return forEachColumnarBatches(this.#path, mergeOptions(this.#options, options), callback);
  }

  forEachRowViews(
    callback: CsvRowViewCallback,
    options: CsvApiFileOptions = {},
  ): Promise<void> {
    return forEachRowViews(this.#path, mergeOptions(this.#options, options), callback);
  }

  withRowViews(
    callback: CsvRowViewCallback,
    options: CsvApiFileOptions = {},
  ): Promise<void> {
    return forEachRowViews(this.#path, mergeOptions(this.#options, options), callback);
  }

  count(options: CsvApiFileOptions = {}): Promise<number> {
    return count(this.#path, mergeOptions(this.#options, options));
  }

  splitOffsets(shardCount: number, options: CsvFileOptions = {}): number[] {
    const merged = mergeOptions(this.#options, options);
    return findCsvSafeSplitOffsetsNative(this.#path, shardCount, merged.delimiter ?? ',');
  }

  shards(shardCount: number, options: CsvFileOptions = {}): CsvShard[] {
    const merged = mergeOptions(this.#options, options);
    return findCsvSafeShardsNative(this.#path, shardCount, merged.delimiter ?? ',');
  }

  dictionary(column: number, options: CsvFileOptions = {}): AsyncGenerator<NativeCsvDictionaryBatch, void> {
    return dictionary(this.#path, column, mergeOptions(this.#options, options));
  }

  groupByCount(column: number, options: CsvFileOptions = {}): Promise<NativeCsvGroupByCountBatch> {
    return groupByCount(this.#path, column, mergeOptions(this.#options, options));
  }

  columnStats(column: number, options: CsvFileOptions = {}): Promise<NativeCsvColumnStatsBatch> {
    return columnStats(this.#path, column, mergeOptions(this.#options, options));
  }

  multiColumnStats(columns: CsvColumns, options: CsvFileOptions = {}): Promise<NativeCsvColumnStatsBatch[]> {
    return multiColumnStats(this.#path, columns, mergeOptions(this.#options, options));
  }
}

export function file(path: string, options: CsvApiFileOptions = {}): CsvFileBuilder {
  return new CsvFileBuilder(path, options);
}

export async function parse<TColumns extends CsvColumns | undefined = undefined>(
  buffer: NodeJS.TypedArray | DataView,
  options: CsvApiFileOptions & { columns?: TColumns; } = {},
): Promise<CsvProjectedRow<TColumns>[]> {
  rejectFilteredStrictSchema(options);
  const parser = new NativeCsvParser(toParserOptions(options));
  const validator = strictSchemaValidator(options);
  try {
    const batch = writeMaterializeBatch(parser, buffer, options, true);
    try {
      validator?.validateBatch(batch);
      validator?.finish();
      return materializeRows(batch, options);
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function* rows<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvApiFileOptions & { columns?: TColumns; } = {},
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  if ((options.workerCount ?? 1) > 1) {
    yield* parallelRows(path, options);
    return;
  }

  rejectFilteredStrictSchema(options);
  const parser = new NativeCsvParser(toParserOptions(options));
  const validator = strictSchemaValidator(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = writeMaterializeBatch(parser, chunk as Buffer, options);
      if (batch.rowCount > 0) {
        try {
          validator?.validateBatch(batch);
          const values = materializeRows(batch, options);
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
        const values = materializeRows(batch, options);
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
export {
  parallelColumnStats,
  parallelGroupByCount,
  parallelMultiColumnStats,
};

export async function* batches(path: string, options: CsvApiFileOptions = {}): AsyncGenerator<NativeCsvBatch, void> {
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
  options: CsvApiFileOptions,
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

export async function forEachColumnarBatches(
  path: string,
  options: CsvApiFileOptions = {},
  callback: CsvColumnarBatchCallback,
): Promise<void> {
  ensureColumnarBatchesSupported(options);
  const scopedBatch = new ScopedCsvColumnarBatchView(selectedColumns(options));
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

export function withColumnarBatches(
  path: string,
  options: CsvApiFileOptions = {},
  callback: CsvColumnarBatchCallback,
): Promise<void> {
  return forEachColumnarBatches(path, options, callback);
}

export async function forEachRowViews(
  path: string,
  options: CsvApiFileOptions = {},
  callback: CsvRowViewCallback,
): Promise<void> {
  ensureRowViewsSupported(options);
  const scopedRowView = new ScopedCsvRowView();
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

export function withRowViews(
  path: string,
  options: CsvApiFileOptions = {},
  callback: CsvRowViewCallback,
): Promise<void> {
  return forEachRowViews(path, options, callback);
}

export async function count(path: string, options: CsvApiFileOptions = {}): Promise<number> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelCount(path, options);
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

export async function* dictionary(
  path: string,
  column: number,
  options: CsvFileOptions = {},
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

export async function groupByCount(
  path: string,
  column: number,
  options: CsvApiFileOptions = {},
): Promise<NativeCsvGroupByCountBatch> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelGroupByCount(path, column, options);
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

export async function columnStats(
  path: string,
  column: number,
  options: CsvApiFileOptions = {},
): Promise<NativeCsvColumnStatsBatch> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelColumnStats(path, column, options);
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

export async function multiColumnStats(
  path: string,
  columns: CsvColumns,
  options: CsvApiFileOptions = {},
): Promise<NativeCsvColumnStatsBatch[]> {
  if ((options.workerCount ?? 1) > 1) {
    return parallelMultiColumnStats(path, columns, options);
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
  return { ...base, ...override };
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
): CsvProjectedRow<TColumns>[] {
  const columns = selectedColumns(options);
  if (usesProjectedMaterialization(options)) {
    return batch.rowsInto([]) as CsvProjectedRow<TColumns>[];
  }
  return batch.rowsInto([], columns) as CsvProjectedRow<TColumns>[];
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
  throw new Error('rows() supports only where.equals; use count() for where.in or where.startsWith');
}

function ensureRowViewsSupported(options: CsvApiFileOptions): void {
  if ((options.workerCount ?? 1) > 1) {
    throw new Error('row view callbacks do not support workerCount; use rows() or withBatches() instead');
  }
}

function ensureColumnarBatchesSupported(options: CsvApiFileOptions): void {
  ensureRowViewsSupported(options);
  if (options.strict === true && selectedColumns(options) !== undefined) {
    throw new Error('columnar batch callbacks do not support strict selectedColumns; use withBatches() instead');
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

class ScopedCsvRowView implements CsvRowView {
  #rowView: NativeCsvRowView | null = null;

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

  get(columnIndex: number) {
    return this.#requireRowView().get(columnIndex);
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

class ScopedCsvColumnarBatchView implements CsvColumnarBatchView {
  readonly #selectedColumns: CsvColumns | undefined;
  #batch: NativeCsvBatch | null = null;

  constructor(selectedColumns: CsvColumns | undefined) {
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

  get selectedColumns(): CsvColumns | undefined {
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

  forEachColumnRange(columnIndex: number, callback: (rowIndex: number, start: number, end: number) => void, startRow?: number, endRow?: number) {
    return this.#requireBatch().forEachColumnRange(columnIndex, callback, startRow, endRow);
  }

  forEachColumnBytes(columnIndex: number, callback: (rowIndex: number, bytes: Uint8Array) => void, startRow?: number, endRow?: number) {
    return this.#requireBatch().forEachColumnBytes(columnIndex, callback, startRow, endRow);
  }

  scanColumns(columns: CsvColumns, callback: (rowIndex: number, ranges: Int32Array, data: Buffer) => void, startRow?: number, endRow?: number) {
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
