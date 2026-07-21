import type { Pointer } from 'bun:ffi';
import {
  EMPTY_BUFFER,
  native,
  requirePtr,
  toArrayBuffer,
  u64ToSafeNumber,
} from './native.ts';
import {
  normalizeColumns,
  normalizeFilterColumn,
} from './normalize.ts';
import type { CsvStringCache } from './string-cache.ts';
import type {
  CsvColumnBytesCallback,
  CsvColumnRangeCallback,
  CsvColumns,
  CsvFieldRange,
  CsvGroupByCountEntry,
  CsvRow,
  CsvScanColumnsCallback,
  NativeCsvRowCallback,
} from './types.ts';

export class NativeCsvRowView {
  #data: Buffer;
  #rowOffsets: BigUint64Array;
  #fieldOffsets: BigUint64Array;
  #rowIndex: number;

  constructor(data: Buffer, rowOffsets: BigUint64Array, fieldOffsets: BigUint64Array, rowIndex = 0) {
    this.#data = data;
    this.#rowOffsets = rowOffsets;
    this.#fieldOffsets = fieldOffsets;
    this.#rowIndex = rowIndex;
  }

  get rowIndex(): number {
    return this.#rowIndex;
  }

  get fieldCount(): number {
    const [rowStart, rowEnd,] = this.#rowRange(this.#rowIndex);
    return rowEnd - rowStart;
  }

  moveTo(rowIndex: number): this {
    this.#rowRange(rowIndex);
    this.#rowIndex = rowIndex;
    return this;
  }

  fieldRange(columnIndex: number): CsvFieldRange | null {
    const [rowStart, rowEnd,] = this.#rowRange(this.#rowIndex);

    const fieldIndex = rowStart + columnIndex;
    if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
      return null;
    }

    return {
      start: offsetAt(this.#fieldOffsets, fieldIndex, 'field offset', this.#data.byteLength),
      end: offsetAt(this.#fieldOffsets, fieldIndex + 1, 'field offset', this.#data.byteLength),
    };
  }

  range(columnIndex: number): CsvFieldRange | null {
    return this.fieldRange(columnIndex);
  }

  fieldBytes(columnIndex: number): Uint8Array | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.subarray(range.start, range.end);
  }

  bytes(columnIndex: number): Uint8Array | null {
    return this.fieldBytes(columnIndex);
  }

  fieldBuffer(columnIndex: number): Buffer | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.subarray(range.start, range.end);
  }

  buffer(columnIndex: number): Buffer | null {
    return this.fieldBuffer(columnIndex);
  }

  fieldString(columnIndex: number): string | null {
    const range = this.fieldRange(columnIndex);
    if (range === null) {
      return null;
    }
    return this.#data.toString('utf8', range.start, range.end);
  }

  getPhysical(columnIndex: number): string | null {
    return this.fieldString(columnIndex);
  }

  get(columnIndex: number): string | null {
    return this.getPhysical(columnIndex);
  }

  pickPhysical(columns: CsvColumns): string[] {
    const values: string[] = [];
    values.length = columns.length;
    for (let index = 0; index < columns.length; ++index) {
      values[index] = this.fieldString(columns[index] ?? 0) ?? '';
    }
    return values;
  }

  pick(columns: CsvColumns): string[] {
    return this.pickPhysical(columns);
  }

  #rowRange(rowIndex: number): readonly [number, number] {
    const maxFieldIndex = this.#fieldOffsets.length - 1;
    const rowStart = offsetAt(this.#rowOffsets, rowIndex, `row ${rowIndex} offset`, maxFieldIndex);
    const rowEnd = offsetAt(this.#rowOffsets, rowIndex + 1, `row ${rowIndex} offset`, maxFieldIndex);
    if (rowEnd < rowStart) {
      throw new RangeError(`row ${rowIndex} offsets are not monotonic`);
    }
    return [rowStart, rowEnd];
  }
}

export class NativeCsvBatch {
  #handle: Pointer | null;
  #data: Buffer | undefined;
  #dataView: Uint8Array | undefined;
  #rowOffsets: BigUint64Array | undefined;
  #fieldOffsets: BigUint64Array | undefined;

  constructor(handle: Pointer) {
    this.#handle = handle;
  }

  get closed(): boolean {
    return this.#handle === null;
  }

  get rowCount(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_row_count(this.#requireHandle()), 'CSV batch row count');
  }

  get totalFields(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_total_fields(this.#requireHandle()), 'CSV batch field count');
  }

  get dataLength(): number {
    return u64ToSafeNumber(native.symbols.csv_batch_data_len(this.#requireHandle()), 'CSV batch data length');
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
    normalizeColumns(columns);
    const rowCount = this.rowCount;
    const totalFields = this.totalFields;
    const rowOffsets = this.rowOffsets();
    const fieldOffsets = this.fieldOffsets();
    const data = this.data();
    target.length = rowCount;

    if (columns !== undefined) {
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        const fieldStart = offsetAt(rowOffsets, rowIndex, `row ${rowIndex} offset`, totalFields);
        const fieldEnd = offsetAt(rowOffsets, rowIndex + 1, `row ${rowIndex} offset`, totalFields);
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

          const start = offsetAt(fieldOffsets, fieldIndex, 'field offset', data.byteLength);
          const end = offsetAt(fieldOffsets, fieldIndex + 1, 'field offset', data.byteLength);
          row[outputIndex] = stringCache === undefined
            ? data.toString('utf8', start, end)
            : stringCache.decode(data, start, end, column);
        }
        target[rowIndex] = row;
      }

      return target;
    }

    for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
      const fieldStart = offsetAt(rowOffsets, rowIndex, `row ${rowIndex} offset`, totalFields);
      const fieldEnd = offsetAt(rowOffsets, rowIndex + 1, `row ${rowIndex} offset`, totalFields);
      const existing = target[rowIndex];
      const row = existing === undefined ? [] : existing;
      row.length = fieldEnd - fieldStart;
      for (let fieldIndex = fieldStart; fieldIndex < fieldEnd; ++fieldIndex) {
        const start = offsetAt(fieldOffsets, fieldIndex, 'field offset', data.byteLength);
        const end = offsetAt(fieldOffsets, fieldIndex + 1, 'field offset', data.byteLength);
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
    const dataLen = u64ToSafeNumber(native.symbols.csv_batch_data_len(handle), 'CSV batch data length');
    const dataPtr = native.symbols.csv_batch_data_ptr(handle);
    this.#dataView = dataLen === 0 ? new Uint8Array(0) : new Uint8Array(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dataView;
  }

  rowOffsets(): BigUint64Array {
    if (this.#rowOffsets !== undefined) {
      return this.#rowOffsets;
    }

    const rowCount = this.rowCount;
    const ptr = native.symbols.csv_batch_row_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV batch row offsets are null');
    }
    this.#rowOffsets = new BigUint64Array(toArrayBuffer(ptr, 0, (rowCount + 1) * BigUint64Array.BYTES_PER_ELEMENT));
    return this.#rowOffsets;
  }

  fieldOffsets(): BigUint64Array {
    if (this.#fieldOffsets !== undefined) {
      return this.#fieldOffsets;
    }

    const totalFields = this.totalFields;
    const ptr = native.symbols.csv_batch_field_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV batch field offsets are null');
    }
    this.#fieldOffsets = new BigUint64Array(
      toArrayBuffer(ptr, 0, (totalFields + 1) * BigUint64Array.BYTES_PER_ELEMENT),
    );
    return this.#fieldOffsets;
  }

  rowFieldCount(rowIndex: number): number {
    const rowOffsets = this.rowOffsets();
    const start = offsetAt(rowOffsets, rowIndex, `row ${rowIndex} offset`, this.totalFields);
    const end = offsetAt(rowOffsets, rowIndex + 1, `row ${rowIndex} offset`, this.totalFields);
    return end - start;
  }

  fieldRange(rowIndex: number, columnIndex: number): CsvFieldRange | null {
    const rowOffsets = this.rowOffsets();
    const fieldOffsets = this.fieldOffsets();
    const totalFields = this.totalFields;
    const dataLength = this.dataLength;
    const rowStart = offsetAt(rowOffsets, rowIndex, `row ${rowIndex} offset`, totalFields);
    const rowEnd = offsetAt(rowOffsets, rowIndex + 1, `row ${rowIndex} offset`, totalFields);

    const fieldIndex = rowStart + columnIndex;
    if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
      return null;
    }

    return {
      start: offsetAt(fieldOffsets, fieldIndex, 'field offset', dataLength),
      end: offsetAt(fieldOffsets, fieldIndex + 1, 'field offset', dataLength),
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

  forEachColumnRange(
    columnIndex: number,
    callback: CsvColumnRangeCallback,
    startRow = 0,
    endRow = this.rowCount,
  ): void {
    const rowOffsets = this.rowOffsets();
    const fieldOffsets = this.fieldOffsets();
    const totalFields = this.totalFields;
    const dataLength = this.dataLength;
    const resolvedEndRow = this.#resolveEndRow(endRow);
    this.#validateRowRange(startRow, resolvedEndRow);

    for (let rowIndex = startRow; rowIndex < resolvedEndRow; ++rowIndex) {
      const rowStart = offsetAt(rowOffsets, rowIndex, `row ${rowIndex} offset`, totalFields);
      const rowEnd = offsetAt(rowOffsets, rowIndex + 1, `row ${rowIndex} offset`, totalFields);

      const fieldIndex = rowStart + columnIndex;
      if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
        continue;
      }

      callback(
        rowIndex,
        offsetAt(fieldOffsets, fieldIndex, 'field offset', dataLength),
        offsetAt(fieldOffsets, fieldIndex + 1, 'field offset', dataLength),
      );
    }
  }

  forEachColumnBytes(
    columnIndex: number,
    callback: CsvColumnBytesCallback,
    startRow = 0,
    endRow = this.rowCount,
  ): void {
    const data = this.data();
    this.forEachColumnRange(
      columnIndex,
      (rowIndex, start, end) => {
        callback(rowIndex, data.subarray(start, end));
      },
      startRow,
      endRow,
    );
  }

  scanColumns(
    columns: CsvColumns,
    callback: CsvScanColumnsCallback,
    startRow = 0,
    endRow = this.rowCount,
  ): void {
    const resolvedEndRow = this.#resolveEndRow(endRow);
    this.#validateRowRange(startRow, resolvedEndRow);
    const rowOffsets = this.rowOffsets();
    const fieldOffsets = this.fieldOffsets();
    const data = this.data();
    const totalFields = this.totalFields;
    const ranges = new Float64Array(columns.length * 2);

    for (let rowIndex = startRow; rowIndex < resolvedEndRow; ++rowIndex) {
      const rowStart = offsetAt(rowOffsets, rowIndex, `row ${rowIndex} offset`, totalFields);
      const rowEnd = offsetAt(rowOffsets, rowIndex + 1, `row ${rowIndex} offset`, totalFields);

      for (let columnOffset = 0; columnOffset < columns.length; ++columnOffset) {
        const columnIndex = columns[columnOffset] ?? 0;
        const fieldIndex = rowStart + columnIndex;
        const rangeIndex = columnOffset * 2;
        if (fieldIndex < rowStart || fieldIndex >= rowEnd) {
          ranges[rangeIndex] = -1;
          ranges[rangeIndex + 1] = -1;
          continue;
        }

        ranges[rangeIndex] = offsetAt(fieldOffsets, fieldIndex, 'field offset', data.byteLength);
        ranges[rangeIndex + 1] = offsetAt(fieldOffsets, fieldIndex + 1, 'field offset', data.byteLength);
      }

      callback(rowIndex, ranges, data);
    }
  }

  countWhereEquals(columnIndex: number, value: string | Buffer | Uint8Array): number {
    normalizeFilterColumn(columnIndex);
    const encoded = typeof value === 'string' ? Buffer.from(value) : value;
    return u64ToSafeNumber(
      native.symbols.csv_batch_count_where_equals(
        this.#requireHandle(),
        columnIndex,
        encoded.byteLength === 0 ? EMPTY_BUFFER : encoded,
        BigInt(encoded.byteLength),
      ),
      'CSV batch filtered row count',
    );
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

  dispose(): void {
    this.close();
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

  #resolveEndRow(endRow: number): number {
    if (Number.isNaN(endRow)) {
      throw new RangeError(`row index out of range: ${endRow}`);
    }
    return endRow;
  }

  #validateRowRange(startRow: number, endRow: number): void {
    const rowCount = this.rowCount;
    if (!Number.isInteger(startRow) || startRow < 0 || startRow > rowCount) {
      throw new RangeError(`row index out of range: ${startRow}`);
    }
    if (!Number.isInteger(endRow) || endRow < startRow || endRow > rowCount) {
      throw new RangeError(`row index out of range: ${endRow}`);
    }
  }
}

export class NativeCsvDictionaryBatch {
  #handle: Pointer | null;
  #ids: Uint32Array | undefined;
  #dictionaryOffsets: BigUint64Array | undefined;
  #dictionaryData: Buffer | undefined;

  constructor(handle: Pointer) {
    this.#handle = handle;
  }

  get closed(): boolean {
    return this.#handle === null;
  }

  get rowCount(): number {
    return u64ToSafeNumber(native.symbols.csv_dictionary_batch_row_count(this.#requireHandle()), 'CSV dictionary row count');
  }

  get dictionaryCount(): number {
    return u64ToSafeNumber(
      native.symbols.csv_dictionary_batch_dict_count(this.#requireHandle()),
      'CSV dictionary entry count',
    );
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

  dictionaryOffsets(): BigUint64Array {
    if (this.#dictionaryOffsets !== undefined) {
      return this.#dictionaryOffsets;
    }
    const dictCount = this.dictionaryCount;
    const ptr = native.symbols.csv_dictionary_batch_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV dictionary offsets are null');
    }
    this.#dictionaryOffsets = new BigUint64Array(
      toArrayBuffer(ptr, 0, (dictCount + 1) * BigUint64Array.BYTES_PER_ELEMENT),
    );
    return this.#dictionaryOffsets;
  }

  dictionaryData(): Buffer {
    if (this.#dictionaryData !== undefined) {
      return this.#dictionaryData;
    }
    const handle = this.#requireHandle();
    const dataLen = u64ToSafeNumber(native.symbols.csv_dictionary_batch_data_len(handle), 'CSV dictionary data length');
    const dataPtr = native.symbols.csv_dictionary_batch_data_ptr(handle);
    this.#dictionaryData = dataLen === 0 ? Buffer.allocUnsafe(0) : Buffer.from(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dictionaryData;
  }

  dictionaryStrings(): string[] {
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const values: string[] = [];
    for (let index = 0; index < this.dictionaryCount; ++index) {
      const [start, end,] = offsetRangeAt(offsets, index, 'dictionary offset', data.byteLength);
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

  dispose(): void {
    this.close();
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

export interface NativeCsvGroupByCountBatchInit {
  counts: BigUint64Array | bigint[];
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array | Uint32Array | readonly (bigint | number)[];
  rowCount: bigint | number;
}

export class NativeCsvGroupByCountBatch {
  #handle: Pointer | null;
  #counts: BigUint64Array | undefined;
  #dictionaryOffsets: BigUint64Array | undefined;
  #dictionaryData: Buffer | undefined;

  constructor(handle: Pointer) {
    this.#handle = handle;
  }

  get closed(): boolean {
    return this.#handle === null;
  }

  get rowCount(): number {
    return u64ToSafeNumber(native.symbols.csv_group_by_count_batch_row_count(this.#requireHandle()), 'CSV groupBy row count');
  }

  get dictionaryCount(): number {
    return u64ToSafeNumber(
      native.symbols.csv_group_by_count_batch_dict_count(this.#requireHandle()),
      'CSV groupBy dictionary entry count',
    );
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

  dictionaryOffsets(): BigUint64Array {
    if (this.#dictionaryOffsets !== undefined) {
      return this.#dictionaryOffsets;
    }
    const dictCount = this.dictionaryCount;
    const ptr = native.symbols.csv_group_by_count_batch_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV groupBy count offsets are null');
    }
    this.#dictionaryOffsets = new BigUint64Array(
      toArrayBuffer(ptr, 0, (dictCount + 1) * BigUint64Array.BYTES_PER_ELEMENT),
    );
    return this.#dictionaryOffsets;
  }

  dictionaryData(): Buffer {
    if (this.#dictionaryData !== undefined) {
      return this.#dictionaryData;
    }
    const handle = this.#requireHandle();
    const dataLen = u64ToSafeNumber(native.symbols.csv_group_by_count_batch_data_len(handle), 'CSV groupBy dictionary data length');
    const dataPtr = native.symbols.csv_group_by_count_batch_data_ptr(handle);
    this.#dictionaryData = dataLen === 0 ? Buffer.allocUnsafe(0) : Buffer.from(toArrayBuffer(requirePtr(dataPtr), 0, dataLen));
    return this.#dictionaryData;
  }

  dictionaryStrings(): string[] {
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const values: string[] = [];
    for (let index = 0; index < this.dictionaryCount; ++index) {
      const [start, end,] = offsetRangeAt(offsets, index, 'dictionary offset', data.byteLength);
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

  dispose(): void {
    this.close();
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

export function createNativeCsvGroupByCountBatch(init: NativeCsvGroupByCountBatchInit): NativeCsvGroupByCountBatch {
  const dictionaryData = asUint8Array(init.dictionaryData);
  const dictionaryOffsets = asBigUint64Offsets(init.dictionaryOffsets, dictionaryData.byteLength);
  const counts = asBigUint64Array(init.counts);
  const rowCount = toBigInt(init.rowCount, 'groupBy rowCount');
  const handle = native.symbols.csv_group_by_count_batch_create(
    asBuffer(dictionaryData),
    BigInt(dictionaryData.byteLength),
    asBuffer(new Uint8Array(dictionaryOffsets.buffer, dictionaryOffsets.byteOffset, dictionaryOffsets.byteLength)),
    BigInt(dictionaryOffsets.length),
    asBuffer(new Uint8Array(counts.buffer, counts.byteOffset, counts.byteLength)),
    BigInt(counts.length),
    rowCount,
  );
  if (handle === null) {
    throw new Error('failed to create native CSV groupBy count batch');
  }
  return new NativeCsvGroupByCountBatch(handle);
}

export interface NativeCsvColumnStatsBatchInit {
  column?: number;
  counts: BigUint64Array | bigint[];
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array | Uint32Array | readonly (bigint | number)[];
  ids: Uint32Array | number[];
}

export class NativeCsvColumnStatsBatch {
  #handle: Pointer | null;
  readonly column: number | undefined;
  #ids: Uint32Array | undefined;
  #counts: BigUint64Array | undefined;
  #dictionaryOffsets: BigUint64Array | undefined;
  #dictionaryDataView: Uint8Array | undefined;
  #dictionaryData: Buffer | undefined;

  constructor(handle: Pointer, column?: number) {
    this.#handle = handle;
    this.column = column;
  }

  get closed(): boolean {
    return this.#handle === null;
  }

  get rowCount(): number {
    return u64ToSafeNumber(native.symbols.csv_column_stats_batch_row_count(this.#requireHandle()), 'CSV column stats row count');
  }

  get dictionaryCount(): number {
    return u64ToSafeNumber(
      native.symbols.csv_column_stats_batch_dict_count(this.#requireHandle()),
      'CSV column stats dictionary entry count',
    );
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

  dictionaryOffsets(): BigUint64Array {
    if (this.#dictionaryOffsets !== undefined) {
      return this.#dictionaryOffsets;
    }
    const dictCount = this.dictionaryCount;
    const ptr = native.symbols.csv_column_stats_batch_offsets_ptr(this.#requireHandle());
    if (ptr === null) {
      throw new Error('native CSV column stats offsets are null');
    }
    this.#dictionaryOffsets = new BigUint64Array(
      toArrayBuffer(ptr, 0, (dictCount + 1) * BigUint64Array.BYTES_PER_ELEMENT),
    );
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
    const dataLen = u64ToSafeNumber(
      native.symbols.csv_column_stats_batch_data_len(handle),
      'CSV column stats dictionary data length',
    );
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
      const [start, end,] = offsetRangeAt(offsets, index, 'dictionary offset', data.byteLength);
      values[index] = data.toString('utf8', start, end);
    }
    return values;
  }

  dictionaryString(index: number): string {
    if (!Number.isInteger(index) || index < 0 || index >= this.dictionaryCount) {
      throw new RangeError(`column stats dictionary index out of range: ${index}`);
    }
    const offsets = this.dictionaryOffsets();
    const data = this.dictionaryData();
    const [start, end,] = offsetRangeAt(offsets, index, 'dictionary offset', data.byteLength);
    return data.toString('utf8', start, end);
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
      const [start, end,] = offsetRangeAt(offsets, index, 'dictionary offset', data.byteLength);
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
      const [start, end,] = offsetRangeAt(offsets, index, 'dictionary offset', data.byteLength);
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

  dispose(): void {
    this.close();
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

export function createNativeCsvColumnStatsBatch(init: NativeCsvColumnStatsBatchInit): NativeCsvColumnStatsBatch {
  const ids = asUint32Array(init.ids);
  const counts = asBigUint64Array(init.counts);
  const dictionaryData = asUint8Array(init.dictionaryData);
  const dictionaryOffsets = asBigUint64Offsets(init.dictionaryOffsets, dictionaryData.byteLength);
  const handle = native.symbols.csv_column_stats_batch_create(
    asBuffer(new Uint8Array(ids.buffer, ids.byteOffset, ids.byteLength)),
    BigInt(ids.length),
    asBuffer(new Uint8Array(counts.buffer, counts.byteOffset, counts.byteLength)),
    BigInt(counts.length),
    asBuffer(new Uint8Array(dictionaryOffsets.buffer, dictionaryOffsets.byteOffset, dictionaryOffsets.byteLength)),
    BigInt(dictionaryOffsets.length),
    asBuffer(dictionaryData),
    BigInt(dictionaryData.byteLength),
  );
  if (handle === null) {
    throw new Error('failed to create native CSV column stats batch');
  }
  return new NativeCsvColumnStatsBatch(handle, init.column);
}

export function takeMultiColumnStatsBatches(handle: Pointer): NativeCsvColumnStatsBatch[] {
  try {
    const columnCount = u64ToSafeNumber(
      native.symbols.csv_multi_column_stats_batch_column_count(handle),
      'CSV multi-column stats column count',
    );
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

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function asUint8Array(value: Uint8Array): Uint8Array {
  return value;
}

function asUint32Array(value: Uint32Array | number[]): Uint32Array {
  return value instanceof Uint32Array ? value : Uint32Array.from(value);
}

function asBigUint64Offsets(
  value: BigUint64Array | Uint32Array | readonly (bigint | number)[],
  dataLength: number,
): BigUint64Array {
  const offsets = value instanceof BigUint64Array ? value : new BigUint64Array(value.length);
  if (!(value instanceof BigUint64Array)) {
    for (let index = 0; index < value.length; ++index) {
      offsets[index] = toBigInt(value[index] ?? 0, 'dictionary offset');
    }
  }
  let previous = 0;
  for (let index = 0; index < offsets.length; ++index) {
    const offset = offsetAt(offsets, index, 'dictionary offset', dataLength);
    if (offset < previous) {
      throw new RangeError(`dictionary offsets are not monotonic at index ${index}`);
    }
    previous = offset;
  }
  return offsets;
}

function asBigUint64Array(value: BigUint64Array | bigint[]): BigUint64Array {
  return value instanceof BigUint64Array ? value : BigUint64Array.from(value);
}

function toBigInt(value: bigint | number, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
      throw new RangeError(`${label} out of range: ${value}`);
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
  return BigInt(value);
}

function offsetAt(offsets: BigUint64Array, index: number, label: string, upperBound: number): number {
  const value = offsets[index];
  if (value === undefined) {
    throw new RangeError(`${label} index out of range: ${index}`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  const offset = Number(value);
  if (offset > upperBound) {
    throw new RangeError(`${label} exceeds backing storage: ${value}`);
  }
  return offset;
}

function offsetRangeAt(
  offsets: BigUint64Array,
  index: number,
  label: string,
  upperBound: number,
): readonly [number, number] {
  const start = offsetAt(offsets, index, label, upperBound);
  const end = offsetAt(offsets, index + 1, label, upperBound);
  if (end < start) {
    throw new RangeError(`${label}s are not monotonic at index ${index + 1}`);
  }
  return [start, end];
}
