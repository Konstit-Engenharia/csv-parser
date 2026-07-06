import { createReadStream } from 'node:fs';
import type {
  NativeCsvBatch,
  NativeCsvColumnStatsBatch,
  NativeCsvDictionaryBatch,
  NativeCsvGroupByCountBatch,
} from './batches.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import { NativeCsvParser } from './parser.ts';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvEncoding,
  CsvFieldValue,
  CsvFileOptions,
  CsvParserOptions,
  CsvProjectedRow,
  CsvWhereFilter,
} from './types.ts';

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

  count(options: CsvApiFileOptions = {}): Promise<number> {
    return count(this.#path, mergeOptions(this.#options, options));
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
  const parser = new NativeCsvParser(toParserOptions(options));
  try {
    const batch = writeRowsBatch(parser, buffer, options, true);
    try {
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
  for await (const batch of batches(path, options)) {
    try {
      const values = materializeRows(batch, options);
      if (values.length > 0) {
        yield values;
      }
    } finally {
      batch.close();
    }
  }
}

export async function* batches(path: string, options: CsvApiFileOptions = {}): AsyncGenerator<NativeCsvBatch, void> {
  ensureRowsWhereSupported(options.where);
  const parser = new NativeCsvParser(toParserOptions(options));
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = writeRowsBatch(parser, chunk as Buffer, options);
      if (batch.rowCount > 0) {
        yield batch;
      } else {
        batch.close();
      }
    }

    const batch = finishRowsBatch(parser, options);
    if (batch.rowCount > 0) {
      yield batch;
    } else {
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

export async function count(path: string, options: CsvApiFileOptions = {}): Promise<number> {
  const parser = new NativeCsvParser(toParserOptions(options));
  let total = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      total += writeCount(parser, chunk as Buffer, options.where);
    }
    total += finishCount(parser, options.where);
    return total;
  } finally {
    parser.close();
  }
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
  options: CsvFileOptions = {},
): Promise<NativeCsvGroupByCountBatch> {
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
  options: CsvFileOptions = {},
): Promise<NativeCsvColumnStatsBatch> {
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
  options: CsvFileOptions = {},
): Promise<NativeCsvColumnStatsBatch[]> {
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

export const csv = {
  file,
  parse,
  rows,
  batches,
  withBatches,
  count,
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
  return batch.rowsInto([], selectedColumns(options)) as CsvProjectedRow<TColumns>[];
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

function ensureRowsWhereSupported(where: CsvWhereFilter | undefined): void {
  if (where === undefined || 'equals' in where) {
    return;
  }
  throw new Error('rows() supports only where.equals; use count() for where.in or where.startsWith');
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
