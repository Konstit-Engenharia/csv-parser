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
}

export interface CsvFileOptions extends CsvParserOptions {
  chunkSize?: number;
}

export interface CsvEqualsFilter {
  column: number;
  value: CsvFieldValue;
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
      .map(([column, cache]) => ({
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

export class NativeCsvBatch {
  #handle: Pointer | null;
  #data: Buffer | undefined;
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

    const handle = this.#requireHandle();
    const dataLen = Number(native.symbols.csv_batch_data_len(handle));
    const dataPtr = native.symbols.csv_batch_data_ptr(handle);
    this.#data = dataLen === 0 ? Buffer.allocUnsafe(0) : Buffer.from(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#data;
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
    const range = this.fieldRange(rowIndex, columnIndex);
    if (range === null) {
      return null;
    }
    return this.data().subarray(range.start, range.end);
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

export class NativeCsvParser {
  #handle: Pointer | null;

  constructor(options: CsvParserOptions = {}) {
    const delimiter = options.delimiter ?? ',';
    if (delimiter.length !== 1) {
      throw new Error('delimiter must be one character');
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
    const batch = native.symbols.csv_parser_write_batch(handle, input, BigInt(input.byteLength), final);
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

  end(): CsvRow[] {
    const batch = this.endBatch();
    try {
      return batch.rows();
    } finally {
      batch.close();
    }
  }

  endBatch(): NativeCsvBatch {
    const batch = native.symbols.csv_parser_finish_batch(this.#requireHandle());
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
