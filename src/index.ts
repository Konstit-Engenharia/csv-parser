import {
  dlopen,
  type Library,
  type Pointer,
  suffix,
  toArrayBuffer,
} from 'bun:ffi';
import {
  createReadStream,
  existsSync,
} from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export type CsvEncoding = 'utf8' | 'latin1' | 'iso88591' | 'iso-8859-1';
export type CsvRow = string[];
export type CsvColumns = readonly number[];
export type CsvFieldValue = string | Buffer | Uint8Array;

export interface CsvFieldRange {
  start: number;
  end: number;
}

export interface CsvParserOptions {
  encoding?: CsvEncoding;
  delimiter?: string;
  selectedColumns?: CsvColumns;
  fixedColumns?: number;
  trusted?: CsvTrustedParserOptions;
}

export interface CsvFileOptions extends CsvParserOptions {
  chunkSize?: number;
}

export interface CsvTrustedParserOptions {
  fixedColumns: number;
  noNewlinesInQuotes: true;
}

export interface CsvEqualsFilter {
  column: number;
  value: CsvFieldValue;
}

export interface CsvInFilter {
  column: number;
  values: readonly CsvFieldValue[];
}

export interface CsvStartsWithFilter {
  column: number;
  prefix: CsvFieldValue;
}

export interface CsvNativeProjectionOptions {
  selectedColumns?: CsvColumns;
  equalsFilter?: CsvEqualsFilter;
}

export interface CsvStringCacheOptions {
  columns?: CsvColumns;
  maxEntriesPerColumn?: number;
}

export interface CsvStringCacheColumnStats {
  column: number;
  entries: number;
  hits: number;
  misses: number;
  full: boolean;
}

export interface CsvGroupByCountEntry {
  value: string;
  count: number;
}

export type NativeCsvRowCallback = (row: NativeCsvRowView, rowIndex: number) => void;

const EMPTY_BUFFER = new Uint8Array(1);
const EMPTY_U32 = new Uint32Array(1);
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const CSV_SYMBOLS = {
  csv_parser_create: {
    args: ['int', 'u8'],
    returns: 'ptr',
  },
  csv_parser_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_parser_reset: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_parser_write_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'ptr',
  },
  csv_parser_finish_batch: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_parser_write_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_trusted_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_trusted_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_projected_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'ptr',
  },
  csv_parser_finish_projected_batch: {
    args: ['ptr', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'ptr',
  },
  csv_parser_write_dictionary_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_dictionary_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_group_by_count: {
    args: ['ptr', 'buffer', 'u64', 'u32'],
    returns: 'u64',
  },
  csv_parser_finish_group_by_count: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_column_stats: {
    args: ['ptr', 'buffer', 'u64', 'u32'],
    returns: 'u64',
  },
  csv_parser_finish_column_stats: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_multi_column_stats: {
    args: ['ptr', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_multi_column_stats: {
    args: ['ptr', 'buffer', 'u64'],
    returns: 'ptr',
  },
  csv_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_dictionary_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_group_by_count_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_column_stats_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_multi_column_stats_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_dictionary_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_dictionary_batch_dict_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_dictionary_batch_ids_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_dictionary_batch_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_dictionary_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_dictionary_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_group_by_count_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_group_by_count_batch_dict_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_group_by_count_batch_counts_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_group_by_count_batch_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_group_by_count_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_group_by_count_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_column_stats_batch_dict_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_column_stats_batch_ids_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_counts_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_column_stats_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_multi_column_stats_batch_column_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_multi_column_stats_batch_column_at: {
    args: ['ptr', 'u64'],
    returns: 'u32',
  },
  csv_multi_column_stats_batch_take_column_batch: {
    args: ['ptr', 'u64'],
    returns: 'ptr',
  },
  csv_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_batch_total_fields: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_batch_row_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_batch_field_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_batch_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_write_count: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'u64',
  },
  csv_parser_count_trusted_newlines: {
    args: ['buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_parser_write_count_where_equals: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_write_count_where_in: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_count_where_in: {
    args: ['ptr', 'u32', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_write_count_where_starts_with: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_count_where_starts_with: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_last_error: {
    args: ['ptr'],
    returns: 'cstring',
  },
} as const;

const native = loadNative();

interface StringCacheEntry {
  bytes: Buffer;
  value: string;
}

interface StringCacheColumn {
  buckets: Map<number, StringCacheEntry[]>;
  entries: number;
  hits: number;
  misses: number;
  full: boolean;
}

export class CsvStringCache {
  readonly #columns: Set<number> | undefined;
  readonly #maxEntriesPerColumn: number;
  readonly #caches = new Map<number, StringCacheColumn>();

  constructor(options: CsvStringCacheOptions = {}) {
    this.#columns = options.columns === undefined ? undefined : new Set(options.columns);
    this.#maxEntriesPerColumn = options.maxEntriesPerColumn ?? 4096;
  }

  decode(data: Buffer, start: number, end: number, column: number): string {
    if (start === end) {
      return '';
    }
    if (this.#columns !== undefined && !this.#columns.has(column)) {
      return data.toString('utf8', start, end);
    }

    const cache = this.#cacheFor(column);
    const hash = hashBytes(data, start, end);
    const bucket = cache.buckets.get(hash);
    if (bucket !== undefined) {
      for (const entry of bucket) {
        if (bytesEqual(data, start, end, entry.bytes)) {
          ++cache.hits;
          return entry.value;
        }
      }
    }

    ++cache.misses;
    const value = data.toString('utf8', start, end);
    if (!cache.full) {
      const entry = {
        bytes: Buffer.from(data.subarray(start, end)),
        value,
      };
      if (bucket === undefined) {
        cache.buckets.set(hash, [entry]);
      } else {
        bucket.push(entry);
      }
      ++cache.entries;
      cache.full = cache.entries >= this.#maxEntriesPerColumn;
    }
    return value;
  }

  stats(): CsvStringCacheColumnStats[] {
    return [...this.#caches.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([column, cache,]) => ({
        column,
        entries: cache.entries,
        hits: cache.hits,
        misses: cache.misses,
        full: cache.full,
      }));
  }

  clear(): void {
    this.#caches.clear();
  }

  #cacheFor(column: number): StringCacheColumn {
    const existing = this.#caches.get(column);
    if (existing !== undefined) {
      return existing;
    }

    const created = {
      buckets: new Map<number, StringCacheEntry[]>(),
      entries: 0,
      hits: 0,
      misses: 0,
      full: false,
    };
    this.#caches.set(column, created);
    return created;
  }
}

export class NativeCsvRowView {
  #data: Buffer;
  #rowOffsets: Uint32Array;
  #fieldOffsets: Uint32Array;
  #rowIndex: number;

  constructor(data: Buffer, rowOffsets: Uint32Array, fieldOffsets: Uint32Array, rowIndex = 0) {
    this.#data = data;
    this.#rowOffsets = rowOffsets;
    this.#fieldOffsets = fieldOffsets;
    this.#rowIndex = rowIndex;
  }

  get rowIndex(): number {
    return this.#rowIndex;
  }

  get fieldCount(): number {
    const rowStart = this.#rowOffsets[this.#rowIndex];
    const rowEnd = this.#rowOffsets[this.#rowIndex + 1];
    if (rowStart === undefined || rowEnd === undefined) {
      throw new RangeError(`row index out of range: ${this.#rowIndex}`);
    }
    return rowEnd - rowStart;
  }

  moveTo(rowIndex: number): this {
    const rowStart = this.#rowOffsets[rowIndex];
    const rowEnd = this.#rowOffsets[rowIndex + 1];
    if (rowStart === undefined || rowEnd === undefined) {
      throw new RangeError(`row index out of range: ${rowIndex}`);
    }
    this.#rowIndex = rowIndex;
    return this;
  }

  fieldRange(columnIndex: number): CsvFieldRange | null {
    const rowStart = this.#rowOffsets[this.#rowIndex];
    const rowEnd = this.#rowOffsets[this.#rowIndex + 1];
    if (rowStart === undefined || rowEnd === undefined) {
      throw new RangeError(`row index out of range: ${this.#rowIndex}`);
    }

    const fieldIndex = rowStart + columnIndex;
    if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
      return null;
    }

    return {
      start: this.#fieldOffsets[fieldIndex] ?? 0,
      end: this.#fieldOffsets[fieldIndex + 1] ?? 0,
    };
  }

  fieldBytes(columnIndex: number): Uint8Array | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.subarray(range.start, range.end);
  }

  fieldBuffer(columnIndex: number): Buffer | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.subarray(range.start, range.end);
  }

  fieldString(columnIndex: number): string | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.toString('utf8', range.start, range.end);
  }
}

export class NativeCsvBatch {
  #handle: Pointer | null;
  #data: Buffer | undefined;
  #dataView: Uint8Array | undefined;
  #rowOffsets: Uint32Array | undefined;
  #fieldOffsets: Uint32Array | undefined;

  constructor(handle: Pointer) {
    this.#handle = handle;
  }

  get rowCount(): number {
    return Number(native.symbols.csv_batch_row_count(this.#requireHandle()));
  }

  get totalFields(): number {
    return Number(native.symbols.csv_batch_total_fields(this.#requireHandle()));
  }

  rows(): CsvRow[] {
    return this.rowsInto([]);
  }

  forEachRow(callback: NativeCsvRowCallback): void {
    const rowCount = this.rowCount;
    const rowView = new NativeCsvRowView(this.data(), this.rowOffsets(), this.fieldOffsets());
    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      callback(rowView.moveTo(rowIndex), rowIndex);
    }
  }

  rowsInto(target: CsvRow[], columns?: CsvColumns, stringCache?: CsvStringCache): CsvRow[] {
    const rowCount = this.rowCount;
    const rowOffsets = this.rowOffsets();
    const fieldOffsets = this.fieldOffsets();
    const data = this.data();
    target.length = rowCount;

    if (columns !== undefined) {
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        const fieldStart = rowOffsets[rowIndex] ?? 0;
        const fieldEnd = rowOffsets[rowIndex + 1] ?? fieldStart;
        const existing = target[rowIndex];
        const row = existing === undefined ? [] : existing;
        row.length = columns.length;

        for (let outputIndex = 0; outputIndex < columns.length; ++outputIndex) {
          const column = columns[outputIndex] ?? 0;
          const fieldIndex = fieldStart + column;
          if (fieldIndex >= fieldEnd) {
            row[outputIndex] = '';
            continue;
          }

          const start = fieldOffsets[fieldIndex] ?? 0;
          const end = fieldOffsets[fieldIndex + 1] ?? start;
          row[outputIndex] = stringCache === undefined
            ? data.toString('utf8', start, end)
            : stringCache.decode(data, start, end, column);
        }
        target[rowIndex] = row;
      }

      return target;
    }

    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      const fieldStart = rowOffsets[rowIndex] ?? 0;
      const fieldEnd = rowOffsets[rowIndex + 1] ?? fieldStart;
      const existing = target[rowIndex];
      const row = existing === undefined ? [] : existing;
      row.length = fieldEnd - fieldStart;
      for (let fieldIndex = fieldStart; fieldIndex < fieldEnd; ++fieldIndex) {
        const start = fieldOffsets[fieldIndex] ?? 0;
        const end = fieldOffsets[fieldIndex + 1] ?? start;
        const column = fieldIndex - fieldStart;
        row[column] = stringCache === undefined
          ? data.toString('utf8', start, end)
          : stringCache.decode(data, start, end, column);
      }
      target[rowIndex] = row;
    }

    return target;
  }

  data(): Buffer {
    if (this.#data !== undefined) {
      return this.#data;
    }

    const view = this.dataView();
    this.#data = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return this.#data;
  }

  dataView(): Uint8Array {
    if (this.#dataView !== undefined) {
      return this.#dataView;
    }

    const handle = this.#requireHandle();
    const dataLen = Number(native.symbols.csv_batch_data_len(handle));
    const dataPtr = native.symbols.csv_batch_data_ptr(handle);
    this.#dataView = dataLen === 0 ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dataView;
  }

  rowOffsets(): Uint32Array {
    if (this.#rowOffsets !== undefined) {
      return this.#rowOffsets;
    }

    const rowCount = this.rowCount;
    const ptr = native.symbols.csv_batch_row_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV batch row offsets are null');
    }
    this.#rowOffsets = new Uint32Array(toArrayBuffer(ptr, 0, (rowCount + 1) * 4));
    return this.#rowOffsets;
  }

  fieldOffsets(): Uint32Array {
    if (this.#fieldOffsets !== undefined) {
      return this.#fieldOffsets;
    }

    const totalFields = this.totalFields;
    const ptr = native.symbols.csv_batch_field_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV batch field offsets are null');
    }
    this.#fieldOffsets = new Uint32Array(toArrayBuffer(ptr, 0, (totalFields + 1) * 4));
    return this.#fieldOffsets;
  }

  rowFieldCount(rowIndex: number): number {
    const rowOffsets = this.rowOffsets();
    const start = rowOffsets[rowIndex];
    const end = rowOffsets[rowIndex + 1];
    if (start === undefined || end === undefined) {
      throw new RangeError(`row index out of range: ${rowIndex}`);
    }
    return end - start;
  }

  fieldRange(rowIndex: number, columnIndex: number): CsvFieldRange | null {
    const rowOffsets = this.rowOffsets();
    const fieldOffsets = this.fieldOffsets();
    const rowStart = rowOffsets[rowIndex];
    const rowEnd = rowOffsets[rowIndex + 1];
    if (rowStart === undefined || rowEnd === undefined) {
      throw new RangeError(`row index out of range: ${rowIndex}`);
    }

    const fieldIndex = rowStart + columnIndex;
    if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
      return null;
    }

    return {
      start: fieldOffsets[fieldIndex] ?? 0,
      end: fieldOffsets[fieldIndex + 1] ?? 0,
    };
  }

  fieldBuffer(rowIndex: number, columnIndex: number): Buffer | null {
    const bytes = this.fieldBytes(rowIndex, columnIndex);
    if (bytes === null) {
      return null;
    }
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  fieldBytes(rowIndex: number, columnIndex: number): Uint8Array | null {
    const range = this.fieldRange(rowIndex, columnIndex);
    if (range === null) {
      return null;
    }
    return this.dataView().subarray(range.start, range.end);
  }

  fieldString(rowIndex: number, columnIndex: number): string | null {
    const range = this.fieldRange(rowIndex, columnIndex);
    if (range === null) {
      return null;
    }
    return this.data().toString('utf8', range.start, range.end);
  }

  countWhereEquals(columnIndex: number, value: string | Buffer | Uint8Array): number {
    const encoded = typeof value === 'string' ? Buffer.from(value) : value;
    return Number(native.symbols.csv_batch_count_where_equals(
      this.#requireHandle(),
      columnIndex,
      encoded.byteLength === 0 ? EMPTY_BUFFER : encoded,
      BigInt(encoded.byteLength),
    ));
  }

  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_batch_destroy(this.#handle);
      this.#handle = null;
      this.#data = undefined;
      this.#dataView = undefined;
      this.#rowOffsets = undefined;
      this.#fieldOffsets = undefined;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): Pointer {
    if (this.#handle === null) {
      throw new Error('native CSV batch is closed');
    }
    return this.#handle;
  }
}

export class NativeCsvDictionaryBatch {
  #handle: Pointer | null;
  #ids: Uint32Array | undefined;
  #dictionaryOffsets: Uint32Array | undefined;
  #dictionaryData: Buffer | undefined;

  constructor(handle: Pointer) {
    this.#handle = handle;
  }

  get rowCount(): number {
    return Number(native.symbols.csv_dictionary_batch_row_count(this.#requireHandle()));
  }

  get dictionaryCount(): number {
    return Number(native.symbols.csv_dictionary_batch_dict_count(this.#requireHandle()));
  }

  ids(): Uint32Array {
    if (this.#ids !== undefined) {
      return this.#ids;
    }
    const rowCount = this.rowCount;
    const ptr = native.symbols.csv_dictionary_batch_ids_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV dictionary ids are null');
    }
    this.#ids = new Uint32Array(toArrayBuffer(ptr, 0, rowCount * 4));
    return this.#ids;
  }

  dictionaryOffsets(): Uint32Array {
    if (this.#dictionaryOffsets !== undefined) {
      return this.#dictionaryOffsets;
    }
    const dictCount = this.dictionaryCount;
    const ptr = native.symbols.csv_dictionary_batch_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV dictionary offsets are null');
    }
    this.#dictionaryOffsets = new Uint32Array(toArrayBuffer(ptr, 0, (dictCount + 1) * 4));
    return this.#dictionaryOffsets;
  }

  dictionaryData(): Buffer {
    if (this.#dictionaryData !== undefined) {
      return this.#dictionaryData;
    }
    const handle = this.#requireHandle();
    const dataLen = Number(native.symbols.csv_dictionary_batch_data_len(handle));
    const dataPtr = native.symbols.csv_dictionary_batch_data_ptr(handle);
    this.#dictionaryData = dataLen === 0 ? Buffer.allocUnsafe(0) : Buffer.from(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dictionaryData;
  }

  dictionaryStrings(): string[] {
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const values: string[] = [];
    for (let index = 0; index < this.dictionaryCount; ++index) {
      const start = offsets[index] ?? 0;
      const end = offsets[index + 1] ?? start;
      values.push(data.toString('utf8', start, end));
    }
    return values;
  }

  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_dictionary_batch_destroy(this.#handle);
      this.#handle = null;
      this.#ids = undefined;
      this.#dictionaryOffsets = undefined;
      this.#dictionaryData = undefined;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): Pointer {
    if (this.#handle === null) {
      throw new Error('native CSV dictionary batch is closed');
    }
    return this.#handle;
  }
}

export class NativeCsvGroupByCountBatch {
  #handle: Pointer | null;
  #counts: BigUint64Array | undefined;
  #dictionaryOffsets: Uint32Array | undefined;
  #dictionaryData: Buffer | undefined;

  constructor(handle: Pointer) {
    this.#handle = handle;
  }

  get rowCount(): number {
    return Number(native.symbols.csv_group_by_count_batch_row_count(this.#requireHandle()));
  }

  get dictionaryCount(): number {
    return Number(native.symbols.csv_group_by_count_batch_dict_count(this.#requireHandle()));
  }

  counts(): BigUint64Array {
    if (this.#counts !== undefined) {
      return this.#counts;
    }
    const dictCount = this.dictionaryCount;
    if (dictCount === 0) {
      this.#counts = new BigUint64Array(0);
      return this.#counts;
    }
    const ptr = native.symbols.csv_group_by_count_batch_counts_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV groupBy count counts are null');
    }
    this.#counts = new BigUint64Array(toArrayBuffer(ptr, 0, dictCount * 8));
    return this.#counts;
  }

  countsNumbers(): number[] {
    return [...this.counts()].map((value) => {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`groupBy count exceeds Number.MAX_SAFE_INTEGER: ${value}`);
      }
      return Number(value);
    });
  }

  dictionaryOffsets(): Uint32Array {
    if (this.#dictionaryOffsets !== undefined) {
      return this.#dictionaryOffsets;
    }
    const dictCount = this.dictionaryCount;
    const ptr = native.symbols.csv_group_by_count_batch_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV groupBy count offsets are null');
    }
    this.#dictionaryOffsets = new Uint32Array(toArrayBuffer(ptr, 0, (dictCount + 1) * 4));
    return this.#dictionaryOffsets;
  }

  dictionaryData(): Buffer {
    if (this.#dictionaryData !== undefined) {
      return this.#dictionaryData;
    }
    const handle = this.#requireHandle();
    const dataLen = Number(native.symbols.csv_group_by_count_batch_data_len(handle));
    const dataPtr = native.symbols.csv_group_by_count_batch_data_ptr(handle);
    this.#dictionaryData = dataLen === 0 ? Buffer.allocUnsafe(0) : Buffer.from(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dictionaryData;
  }

  dictionaryStrings(): string[] {
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const values: string[] = [];
    for (let index = 0; index < this.dictionaryCount; ++index) {
      const start = offsets[index] ?? 0;
      const end = offsets[index + 1] ?? start;
      values.push(data.toString('utf8', start, end));
    }
    return values;
  }

  entries(): CsvGroupByCountEntry[] {
    const values = this.dictionaryStrings();
    const counts = this.countsNumbers();
    return values.map((value, index) => ({
      value,
      count: counts[index] ?? 0,
    }));
  }

  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_group_by_count_batch_destroy(this.#handle);
      this.#handle = null;
      this.#counts = undefined;
      this.#dictionaryOffsets = undefined;
      this.#dictionaryData = undefined;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): Pointer {
    if (this.#handle === null) {
      throw new Error('native CSV groupBy count batch is closed');
    }
    return this.#handle;
  }
}

export class NativeCsvColumnStatsBatch {
  #handle: Pointer | null;
  readonly column: number | undefined;
  #ids: Uint32Array | undefined;
  #counts: BigUint64Array | undefined;
  #dictionaryOffsets: Uint32Array | undefined;
  #dictionaryDataView: Uint8Array | undefined;
  #dictionaryData: Buffer | undefined;

  constructor(handle: Pointer, column?: number) {
    this.#handle = handle;
    this.column = column;
  }

  get rowCount(): number {
    return Number(native.symbols.csv_column_stats_batch_row_count(this.#requireHandle()));
  }

  get dictionaryCount(): number {
    return Number(native.symbols.csv_column_stats_batch_dict_count(this.#requireHandle()));
  }

  ids(): Uint32Array {
    if (this.#ids !== undefined) {
      return this.#ids;
    }
    const rowCount = this.rowCount;
    if (rowCount === 0) {
      this.#ids = new Uint32Array(0);
      return this.#ids;
    }
    const ptr = native.symbols.csv_column_stats_batch_ids_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV column stats ids are null');
    }
    this.#ids = new Uint32Array(toArrayBuffer(ptr, 0, rowCount * 4));
    return this.#ids;
  }

  counts(): BigUint64Array {
    if (this.#counts !== undefined) {
      return this.#counts;
    }
    const dictCount = this.dictionaryCount;
    if (dictCount === 0) {
      this.#counts = new BigUint64Array(0);
      return this.#counts;
    }
    const ptr = native.symbols.csv_column_stats_batch_counts_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV column stats counts are null');
    }
    this.#counts = new BigUint64Array(toArrayBuffer(ptr, 0, dictCount * 8));
    return this.#counts;
  }

  countsNumbers(): number[] {
    const counts = this.counts();
    const values: number[] = [];
    values.length = counts.length;
    for (let index = 0; index < counts.length; ++index) {
      values[index] = columnStatsCountToNumber(counts[index] ?? 0n);
    }
    return values;
  }

  dictionaryOffsets(): Uint32Array {
    if (this.#dictionaryOffsets !== undefined) {
      return this.#dictionaryOffsets;
    }
    const dictCount = this.dictionaryCount;
    const ptr = native.symbols.csv_column_stats_batch_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV column stats offsets are null');
    }
    this.#dictionaryOffsets = new Uint32Array(toArrayBuffer(ptr, 0, (dictCount + 1) * 4));
    return this.#dictionaryOffsets;
  }

  dictionaryData(): Buffer {
    if (this.#dictionaryData !== undefined) {
      return this.#dictionaryData;
    }
    const view = this.dictionaryDataView();
    this.#dictionaryData = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    return this.#dictionaryData;
  }

  dictionaryDataView(): Uint8Array {
    if (this.#dictionaryDataView !== undefined) {
      return this.#dictionaryDataView;
    }
    const handle = this.#requireHandle();
    const dataLen = Number(native.symbols.csv_column_stats_batch_data_len(handle));
    const dataPtr = native.symbols.csv_column_stats_batch_data_ptr(handle);
    this.#dictionaryDataView = dataLen === 0 ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dictionaryDataView;
  }

  dictionaryStrings(): string[] {
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const values: string[] = [];
    values.length = this.dictionaryCount;
    for (let index = 0; index < values.length; ++index) {
      const start = offsets[index] ?? 0;
      const end = offsets[index + 1] ?? start;
      values[index] = data.toString('utf8', start, end);
    }
    return values;
  }

  dictionaryString(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.dictionaryCount) {
      throw new RangeError(`column stats dictionary index out of range: ${index}`);
    }
    const offsets = this.dictionaryOffsets();
    const start = offsets[index] ?? 0;
    const end = offsets[index + 1] ?? start;
    return this.dictionaryData().toString('utf8', start, end);
  }

  countNumberAt(index: number): number {
    if (!Number.isInteger(index) || index < 0 || index >= this.dictionaryCount) {
      throw new RangeError(`column stats count index out of range: ${index}`);
    }
    return columnStatsCountToNumber(this.counts()[index] ?? 0n);
  }

  entries(): CsvGroupByCountEntry[] {
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const counts = this.counts();
    const values: CsvGroupByCountEntry[] = [];
    values.length = this.dictionaryCount;
    for (let index = 0; index < values.length; ++index) {
      const start = offsets[index] ?? 0;
      const end = offsets[index + 1] ?? start;
      values[index] = {
        value: data.toString('utf8', start, end),
        count: columnStatsCountToNumber(counts[index] ?? 0n),
      };
    }
    return values;
  }

  forEachEntry(callback: (value: string, count: number, index: number) => void): void {
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const counts = this.counts();
    for (let index = 0; index < this.dictionaryCount; ++index) {
      const start = offsets[index] ?? 0;
      const end = offsets[index + 1] ?? start;
      callback(data.toString('utf8', start, end), columnStatsCountToNumber(counts[index] ?? 0n), index);
    }
  }

  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_column_stats_batch_destroy(this.#handle);
      this.#handle = null;
      this.#ids = undefined;
      this.#counts = undefined;
      this.#dictionaryOffsets = undefined;
      this.#dictionaryDataView = undefined;
      this.#dictionaryData = undefined;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): Pointer {
    if (this.#handle === null) {
      throw new Error('native CSV column stats batch is closed');
    }
    return this.#handle;
  }
}

function takeMultiColumnStatsBatches(handle: Pointer): NativeCsvColumnStatsBatch[] {
  try {
    const columnCount = Number(native.symbols.csv_multi_column_stats_batch_column_count(handle));
    const batches: NativeCsvColumnStatsBatch[] = [];
    batches.length = columnCount;
    for (let index = 0; index < columnCount; ++index) {
      const column = native.symbols.csv_multi_column_stats_batch_column_at(handle, BigInt(index));
      const batch = native.symbols.csv_multi_column_stats_batch_take_column_batch(handle, BigInt(index));
      if (batch === null) {
        throw new Error(`native CSV multi-column stats batch ${index} is null`);
      }
      batches[index] = new NativeCsvColumnStatsBatch(batch, column);
    }
    return batches;
  } finally {
    native.symbols.csv_multi_column_stats_batch_destroy(handle);
  }
}

function columnStatsCountToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`column stats count exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  return Number(value);
}

export class NativeCsvParser {
  #handle: Pointer | null;
  readonly #fixedColumns: number | undefined;
  readonly #trustedFixedColumns: number | undefined;

  constructor(options: CsvParserOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1) {
      throw new Error('delimiter must be one character');
    }
    this.#fixedColumns = normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
    this.#trustedFixedColumns = normalizeTrustedFixedColumns(options.trusted);
    if (this.#fixedColumns !== undefined && this.#trustedFixedColumns !== undefined) {
      throw new Error('use fixedColumns or trusted.fixedColumns, not both');
    }

    this.#handle = native.symbols.csv_parser_create(encodingCode(options.encoding), delimiter.charCodeAt(0));
    if (this.#handle === null) {
      throw new Error('failed to create native CSV parser');
    }
  }

  write(chunk: NodeJS.TypedArray | DataView, final = false): CsvRow[] {
    const batch = this.writeBatch(chunk, final);
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

  writeBatch(chunk: NodeJS.TypedArray | DataView, final = false): NativeCsvBatch {
    if (chunk.byteLength === 0 && final) {
      return this.endBatch();
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const batch = this.#trustedFixedColumns !== undefined
      ? native.symbols.csv_parser_write_trusted_fixed_batch(
        handle,
        input,
        BigInt(input.byteLength),
        final,
        this.#trustedFixedColumns,
      )
      : this.#fixedColumns !== undefined
        ? native.symbols.csv_parser_write_fixed_batch(
          handle,
          input,
          BigInt(input.byteLength),
          final,
          this.#fixedColumns,
        )
        : native.symbols.csv_parser_write_batch(handle, input, BigInt(input.byteLength), final);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  writeProjectedBatch(
    chunk: NodeJS.TypedArray | DataView,
    options: CsvNativeProjectionOptions = {},
    final = false,
  ): NativeCsvBatch {
    if (chunk.byteLength === 0 && final) {
      return this.endProjectedBatch(options);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const columns = normalizeColumns(options.selectedColumns);
    const filter = normalizeEqualsFilter(options.equalsFilter);
    const batch = native.symbols.csv_parser_write_projected_batch(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      options.selectedColumns !== undefined,
      columns,
      BigInt(options.selectedColumns?.length ?? 0),
      filter.enabled,
      filter.column,
      filter.value,
      BigInt(filter.valueLength),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  writeDictionaryBatch(chunk: NodeJS.TypedArray | DataView, column: number, final = false): NativeCsvDictionaryBatch {
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`dictionary column out of range: ${column}`);
    }
    if (chunk.byteLength === 0 && final) {
      return this.endDictionaryBatch(column);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const batch = native.symbols.csv_parser_write_dictionary_batch(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      column,
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvDictionaryBatch(batch);
  }

  writeGroupByCount(chunk: NodeJS.TypedArray | DataView, column: number): number {
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`groupBy count column out of range: ${column}`);
    }
    if (chunk.byteLength === 0) {
      return 0;
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_group_by_count(
      handle,
      input,
      BigInt(input.byteLength),
      column,
    ));
  }

  writeColumnStats(chunk: NodeJS.TypedArray | DataView, column: number): number {
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`column stats column out of range: ${column}`);
    }
    if (chunk.byteLength === 0) {
      return 0;
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_column_stats(
      handle,
      input,
      BigInt(input.byteLength),
      column,
    ));
  }

  writeMultiColumnStats(chunk: NodeJS.TypedArray | DataView, columns: CsvColumns): number {
    if (chunk.byteLength === 0 || columns.length === 0) {
      return 0;
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const normalizedColumns = normalizeColumnStatsColumns(columns);
    return Number(native.symbols.csv_parser_write_multi_column_stats(
      handle,
      input,
      BigInt(input.byteLength),
      normalizedColumns,
      BigInt(normalizedColumns.length),
    ));
  }

  end(): CsvRow[] {
    const batch = this.endBatch();
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

  endBatch(): NativeCsvBatch {
    const batch = this.#trustedFixedColumns !== undefined
      ? native.symbols.csv_parser_finish_trusted_fixed_batch(this.#requireHandle(), this.#trustedFixedColumns)
      : this.#fixedColumns !== undefined
        ? native.symbols.csv_parser_finish_fixed_batch(this.#requireHandle(), this.#fixedColumns)
        : native.symbols.csv_parser_finish_batch(this.#requireHandle());
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  endProjectedBatch(options: CsvNativeProjectionOptions = {}): NativeCsvBatch {
    const columns = normalizeColumns(options.selectedColumns);
    const filter = normalizeEqualsFilter(options.equalsFilter);
    const batch = native.symbols.csv_parser_finish_projected_batch(
      this.#requireHandle(),
      options.selectedColumns !== undefined,
      columns,
      BigInt(options.selectedColumns?.length ?? 0),
      filter.enabled,
      filter.column,
      filter.value,
      BigInt(filter.valueLength),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvBatch(batch);
  }

  endDictionaryBatch(column: number): NativeCsvDictionaryBatch {
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`dictionary column out of range: ${column}`);
    }
    const batch = native.symbols.csv_parser_finish_dictionary_batch(this.#requireHandle(), column);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvDictionaryBatch(batch);
  }

  endGroupByCount(column: number): NativeCsvGroupByCountBatch {
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`groupBy count column out of range: ${column}`);
    }
    const batch = native.symbols.csv_parser_finish_group_by_count(this.#requireHandle(), column);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvGroupByCountBatch(batch);
  }

  endColumnStats(column: number): NativeCsvColumnStatsBatch {
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`column stats column out of range: ${column}`);
    }
    const batch = native.symbols.csv_parser_finish_column_stats(this.#requireHandle(), column);
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return new NativeCsvColumnStatsBatch(batch);
  }

  endMultiColumnStats(columns: CsvColumns): NativeCsvColumnStatsBatch[] {
    if (columns.length === 0) {
      return [];
    }

    const normalizedColumns = normalizeColumnStatsColumns(columns);
    const batch = native.symbols.csv_parser_finish_multi_column_stats(
      this.#requireHandle(),
      normalizedColumns,
      BigInt(normalizedColumns.length),
    );
    if (batch === null) {
      throw new Error(`native CSV parser failed: ${this.#lastError()}`);
    }
    return takeMultiColumnStatsBatches(batch);
  }

  writeCount(chunk: NodeJS.TypedArray | DataView, final = false): number {
    if (chunk.byteLength === 0 && final) {
      return this.endCount();
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_count(handle, input, BigInt(input.byteLength), final));
  }

  endCount(): number {
    return Number(native.symbols.csv_parser_finish_count(this.#requireHandle()));
  }

  writeCountWhereEquals(chunk: NodeJS.TypedArray | DataView, filter: CsvEqualsFilter, final = false): number {
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereEquals(filter);
    }

    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    const normalized = normalizeEqualsFilter(filter);
    return Number(native.symbols.csv_parser_write_count_where_equals(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  endCountWhereEquals(filter: CsvEqualsFilter): number {
    const normalized = normalizeEqualsFilter(filter);
    return Number(native.symbols.csv_parser_finish_count_where_equals(
      this.#requireHandle(),
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  writeCountWhereIn(chunk: NodeJS.TypedArray | DataView, filter: CsvInFilter, final = false): number {
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereIn(filter);
    }

    const normalized = normalizeInFilter(filter);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_count_where_in(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      normalized.column,
      normalized.valuesData,
      BigInt(normalized.valuesDataLength),
      normalized.offsets,
      BigInt(normalized.valueCount),
    ));
  }

  endCountWhereIn(filter: CsvInFilter): number {
    const normalized = normalizeInFilter(filter);
    return Number(native.symbols.csv_parser_finish_count_where_in(
      this.#requireHandle(),
      normalized.column,
      normalized.valuesData,
      BigInt(normalized.valuesDataLength),
      normalized.offsets,
      BigInt(normalized.valueCount),
    ));
  }

  writeCountWhereStartsWith(chunk: NodeJS.TypedArray | DataView, filter: CsvStartsWithFilter, final = false): number {
    if (chunk.byteLength === 0 && final) {
      return this.endCountWhereStartsWith(filter);
    }

    const normalized = normalizeStartsWithFilter(filter);
    const handle = this.#requireHandle();
    const input = normalizeChunk(chunk);
    return Number(native.symbols.csv_parser_write_count_where_starts_with(
      handle,
      input,
      BigInt(input.byteLength),
      final,
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  endCountWhereStartsWith(filter: CsvStartsWithFilter): number {
    const normalized = normalizeStartsWithFilter(filter);
    return Number(native.symbols.csv_parser_finish_count_where_starts_with(
      this.#requireHandle(),
      normalized.column,
      normalized.value,
      BigInt(normalized.valueLength),
    ));
  }

  reset(): void {
    native.symbols.csv_parser_reset(this.#requireHandle());
  }

  close(): void {
    if (this.#handle !== null) {
      native.symbols.csv_parser_destroy(this.#handle);
      this.#handle = null;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #requireHandle(): Pointer {
    if (this.#handle === null) {
      throw new Error('native CSV parser is closed');
    }
    return this.#handle;
  }

  #lastError(): string {
    if (this.#handle === null) {
      return 'parser is closed';
    }
    const value = native.symbols.csv_parser_last_error(this.#handle);
    return value.toString();
  }
}

export function parseCsvBuffer(buffer: NodeJS.TypedArray | DataView, options: CsvParserOptions = {}): CsvRow[] {
  const parser = new NativeCsvParser(options);
  try {
    const batch = parser.writeBatch(buffer, true);
    try {
      return batch.rowsInto([], options.selectedColumns);
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export function countTrustedNewlineRows(buffer: NodeJS.TypedArray | DataView): number {
  if (buffer.byteLength === 0) {
    return 0;
  }
  const input = normalizeChunk(buffer);
  return Number(native.symbols.csv_parser_count_trusted_newlines(input, BigInt(input.byteLength)));
}

export async function* parseCsvFile(path: string, options: CsvFileOptions = {}): AsyncGenerator<CsvRow[], void> {
  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        const rows = batch.rowsInto([], options.selectedColumns);
        if (rows.length > 0) {
          yield rows;
        }
      } finally {
        batch.close();
      }
    }

    const batch = parser.endBatch();
    try {
      const rows = batch.rowsInto([], options.selectedColumns);
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function* parseCsvFileProjected(
  path: string,
  options: CsvFileOptions & CsvNativeProjectionOptions = {},
): AsyncGenerator<CsvRow[], void> {
  const parser = new NativeCsvParser(options);
  const projectionOptions: CsvNativeProjectionOptions = {
    selectedColumns: options.selectedColumns,
    equalsFilter: options.equalsFilter,
  };
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = parser.writeProjectedBatch(chunk as Buffer, projectionOptions);
      try {
        const rows = batch.rows();
        if (rows.length > 0) {
          yield rows;
        }
      } finally {
        batch.close();
      }
    }

    const batch = parser.endProjectedBatch(projectionOptions);
    try {
      const rows = batch.rows();
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function* parseCsvFileDictionary(
  path: string,
  columnIndex: number,
  options: CsvFileOptions = {},
): AsyncGenerator<NativeCsvDictionaryBatch, void> {
  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = parser.writeDictionaryBatch(chunk as Buffer, columnIndex);
      if (batch.rowCount > 0) {
        yield batch;
      } else {
        batch.close();
      }
    }

    const batch = parser.endDictionaryBatch(columnIndex);
    if (batch.rowCount > 0) {
      yield batch;
    } else {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function parseCsvFileGroupByCount(
  path: string,
  columnIndex: number,
  options: CsvFileOptions = {},
): Promise<NativeCsvGroupByCountBatch> {
  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeGroupByCount(chunk as Buffer, columnIndex);
    }
    return parser.endGroupByCount(columnIndex);
  } finally {
    parser.close();
  }
}

export async function parseCsvFileColumnStats(
  path: string,
  columnIndex: number,
  options: CsvFileOptions = {},
): Promise<NativeCsvColumnStatsBatch> {
  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeColumnStats(chunk as Buffer, columnIndex);
    }
    return parser.endColumnStats(columnIndex);
  } finally {
    parser.close();
  }
}

export async function parseCsvFileMultiColumnStats(
  path: string,
  columns: CsvColumns,
  options: CsvFileOptions = {},
): Promise<NativeCsvColumnStatsBatch[]> {
  if (columns.length === 0) {
    return [];
  }

  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeMultiColumnStats(chunk as Buffer, columns);
    }
    return parser.endMultiColumnStats(columns);
  } finally {
    parser.close();
  }
}

export async function countCsvFile(path: string, options: CsvFileOptions = {}): Promise<number> {
  const parser = new NativeCsvParser(options);
  let rows = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCount(chunk as Buffer);
    }
    rows += parser.endCount();
    return rows;
  } finally {
    parser.close();
  }
}

export async function countCsvFileWhereEquals(
  path: string,
  columnIndex: number,
  value: CsvFieldValue,
  options: CsvFileOptions = {},
): Promise<number> {
  const parser = new NativeCsvParser(options);
  const filter = { column: columnIndex, value };
  let rows = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCountWhereEquals(chunk as Buffer, filter);
    }
    rows += parser.endCountWhereEquals(filter);
    return rows;
  } finally {
    parser.close();
  }
}

export async function countCsvFileWhereIn(
  path: string,
  columnIndex: number,
  values: readonly CsvFieldValue[],
  options: CsvFileOptions = {},
): Promise<number> {
  if (values.length === 0) {
    return 0;
  }

  const parser = new NativeCsvParser(options);
  const filter = { column: columnIndex, values };
  let rows = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCountWhereIn(chunk as Buffer, filter);
    }
    rows += parser.endCountWhereIn(filter);
    return rows;
  } finally {
    parser.close();
  }
}

export async function countCsvFileWhereStartsWith(
  path: string,
  columnIndex: number,
  prefix: CsvFieldValue,
  options: CsvFileOptions = {},
): Promise<number> {
  const parser = new NativeCsvParser(options);
  const filter = { column: columnIndex, prefix };
  let rows = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCountWhereStartsWith(chunk as Buffer, filter);
    }
    rows += parser.endCountWhereStartsWith(filter);
    return rows;
  } finally {
    parser.close();
  }
}

function loadNative(): Library<typeof CSV_SYMBOLS> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    join(root, 'build', `libcsv_native.${suffix}`),
    join(root, 'build', 'Release', `libcsv_native.${suffix}`),
    join(root, `libcsv_native.${suffix}`),
  ];
  const libraryPath = candidates.find((candidate) => existsSync(candidate));
  if (libraryPath === undefined) {
    throw new Error(`native library not found. Run: bun run build:native`);
  }

  return dlopen(resolve(libraryPath), CSV_SYMBOLS);
}

function encodingCode(encoding: CsvEncoding = 'utf8'): number {
  const normalized = encoding.toLowerCase();
  if (normalized === 'utf8') {
    return 0;
  }
  if (normalized === 'latin1' || normalized === 'iso88591' || normalized === 'iso-8859-1') {
    return 1;
  }
  throw new Error(`unsupported encoding: ${encoding}`);
}

function normalizeChunk(chunk: NodeJS.TypedArray | DataView): NodeJS.TypedArray | DataView {
  return chunk.byteLength === 0 ? EMPTY_BUFFER : chunk;
}

function normalizeTrustedFixedColumns(trusted: CsvTrustedParserOptions | undefined): number | undefined {
  if (trusted === undefined) {
    return undefined;
  }
  if (trusted.noNewlinesInQuotes !== true) {
    throw new Error('trusted.noNewlinesInQuotes must be true');
  }
  return normalizeFixedColumnsCount(trusted.fixedColumns, 'trusted fixed column count');
}

function normalizeFixedColumnsCount(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
  return value;
}

function normalizeColumns(columns: CsvColumns | undefined): Uint32Array {
  if (columns === undefined) {
    return EMPTY_U32;
  }

  const normalized = new Uint32Array(columns.length);
  for (let index = 0; index < columns.length; ++index) {
    const column = columns[index] ?? NaN;
    if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
      throw new RangeError(`selected column out of range: ${column}`);
    }
    normalized[index] = column;
  }
  return normalized.length === 0 ? EMPTY_U32 : normalized;
}

function normalizeColumnStatsColumns(columns: CsvColumns): Uint32Array {
  const normalized = normalizeColumns(columns);
  const seen = new Set<number>();
  for (const column of normalized) {
    if (seen.has(column)) {
      throw new RangeError(`multi-column stats column repeated: ${column}`);
    }
    seen.add(column);
  }
  return normalized;
}

function normalizeEqualsFilter(filter: CsvEqualsFilter | undefined): {
  enabled: boolean;
  column: number;
  value: Uint8Array;
  valueLength: number;
} {
  if (filter === undefined) {
    return {
      enabled: false,
      column: 0,
      value: EMPTY_BUFFER,
      valueLength: 0,
    };
  }

  if (!Number.isInteger(filter.column) || filter.column < 0 || filter.column > 0xffff_ffff) {
    throw new RangeError(`filter column out of range: ${filter.column}`);
  }

  const value = typeof filter.value === 'string' ? Buffer.from(filter.value) : filter.value;
  return {
    enabled: true,
    column: filter.column,
    value: value.byteLength === 0 ? EMPTY_BUFFER : value,
    valueLength: value.byteLength,
  };
}

function normalizeFilterColumn(column: number): number {
  if (!Number.isInteger(column) || column < 0 || column > 0xffff_ffff) {
    throw new RangeError(`filter column out of range: ${column}`);
  }
  return column;
}

function normalizeFilterValue(value: CsvFieldValue): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value) : value;
}

function normalizeInFilter(filter: CsvInFilter): {
  column: number;
  valuesData: Uint8Array;
  valuesDataLength: number;
  offsets: Uint32Array;
  valueCount: number;
} {
  const column = normalizeFilterColumn(filter.column);
  if (filter.values.length === 0) {
    throw new RangeError('filter values must not be empty');
  }

  const values = filter.values.map((value) => normalizeFilterValue(value));
  let valuesDataLength = 0;
  for (const value of values) {
    valuesDataLength += value.byteLength;
    if (valuesDataLength > 0xffff_ffff) {
      throw new RangeError('filter values exceed native offset range');
    }
  }

  const valuesData = valuesDataLength === 0 ? EMPTY_BUFFER : new Uint8Array(valuesDataLength);
  const offsets = new Uint32Array(values.length + 1);
  let offset = 0;
  for (let index = 0; index < values.length; ++index) {
    const value = values[index] ?? EMPTY_BUFFER;
    offsets[index] = offset;
    valuesData.set(value, offset);
    offset += value.byteLength;
  }
  offsets[values.length] = offset;

  return {
    column,
    valuesData,
    valuesDataLength,
    offsets,
    valueCount: values.length,
  };
}

function normalizeStartsWithFilter(filter: CsvStartsWithFilter): {
  column: number;
  value: Uint8Array;
  valueLength: number;
} {
  const column = normalizeFilterColumn(filter.column);
  const value = normalizeFilterValue(filter.prefix);
  return {
    column,
    value: value.byteLength === 0 ? EMPTY_BUFFER : value,
    valueLength: value.byteLength,
  };
}

function requirePtr(ptr: Pointer | null): Pointer {
  if (ptr === null) {
    throw new Error('native CSV pointer is null');
  }
  return ptr;
}

function hashBytes(data: Buffer, start: number, end: number): number {
  let hash = 0x811c9dc5;
  for (let index = start; index < end; ++index) {
    hash ^= data[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function bytesEqual(data: Buffer, start: number, end: number, expected: Buffer): boolean {
  const len = end - start;
  if (expected.byteLength !== len) {
    return false;
  }
  for (let index = 0; index < len; ++index) {
    if (data[start + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}
