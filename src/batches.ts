import type { Pointer } from 'bun:ffi';
import {
  EMPTY_BUFFER,
  native,
  requirePtr,
  toArrayBuffer,
} from './native.ts';
import type { CsvStringCache } from './string-cache.ts';
import type {
  CsvColumns,
  CsvFieldRange,
  CsvGroupByCountEntry,
  CsvRow,
  NativeCsvRowCallback,
} from './types.ts';

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

export function takeMultiColumnStatsBatches(handle: Pointer): NativeCsvColumnStatsBatch[] {
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
