import type { NativeCsvRowView } from './batches.ts';

export type CsvEncoding = 'utf8' | 'latin1' | 'iso88591' | 'iso-8859-1';
export type CsvRow = string[];
export type CsvColumns = readonly number[];
export type CsvFieldValue = string | Buffer | Uint8Array;

export interface CsvFieldRange {
  start: number;
  end: number;
}

export interface CsvShard {
  start: number;
  end: number;
}

export interface CsvParserOptions {
  encoding?: CsvEncoding;
  delimiter?: string;
  selectedColumns?: CsvColumns;
  fixedColumns?: number;
  strict?: boolean;
  expectedHeaders?: readonly string[];
  requireHeader?: boolean;
  minDataRows?: number;
  trusted?: CsvTrustedParserOptions;
}

export interface CsvFileOptions extends CsvParserOptions {
  chunkSize?: number;
}

export interface CsvTrustedParserOptions {
  fixedColumns: number;
  noNewlinesInQuotes: true;
}

export type CsvWhereFilter =
  | CsvWhereEqualsFilter
  | CsvWhereInFilter
  | CsvWhereStartsWithFilter;

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

export interface CsvWhereEqualsFilter {
  column: number;
  equals: CsvFieldValue;
}

export interface CsvWhereInFilter {
  column: number;
  in: readonly CsvFieldValue[];
}

export interface CsvWhereStartsWithFilter {
  column: number;
  startsWith: CsvFieldValue;
}

export interface CsvNativeProjectionOptions {
  selectedColumns?: CsvColumns;
  equalsFilter?: CsvEqualsFilter;
}

export interface CsvApiFileOptions extends CsvFileOptions {
  columns?: CsvColumns;
  trustedFixedColumns?: number;
  workerCount?: number;
  where?: CsvWhereFilter;
}

export type CsvProjectedRow<TColumns extends CsvColumns | undefined> = TColumns extends readonly unknown[]
  ? { -readonly [Index in keyof TColumns]: string; }
  : CsvRow;

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

export type CsvRowView = Pick<
  NativeCsvRowView,
  | 'rowIndex'
  | 'fieldCount'
  | 'fieldRange'
  | 'range'
  | 'fieldBytes'
  | 'bytes'
  | 'fieldBuffer'
  | 'buffer'
  | 'fieldString'
  | 'get'
  | 'pick'
>;

export type CsvRowViewCallback = (row: CsvRowView, rowIndex: number) => void;
export type NativeCsvRowCallback = (row: NativeCsvRowView, rowIndex: number) => void;
export type CsvColumnRangeCallback = (rowIndex: number, start: number, end: number) => void;
export type CsvColumnBytesCallback = (rowIndex: number, bytes: Uint8Array) => void;
export type CsvScanColumnsCallback = (rowIndex: number, ranges: Int32Array, data: Buffer) => void;

export interface CsvColumnarBatchView {
  readonly rowCount: number;
  readonly totalFields: number;
  readonly dataLength: number;
  readonly selectedColumns: CsvColumns | undefined;
  data(): Buffer;
  dataView(): Uint8Array;
  rowOffsets(): Uint32Array;
  fieldOffsets(): Uint32Array;
  rowFieldCount(rowIndex: number): number;
  fieldRange(rowIndex: number, columnIndex: number): CsvFieldRange | null;
  fieldBytes(rowIndex: number, columnIndex: number): Uint8Array | null;
  fieldBuffer(rowIndex: number, columnIndex: number): Buffer | null;
  forEachColumnRange(columnIndex: number, callback: CsvColumnRangeCallback, startRow?: number, endRow?: number): void;
  forEachColumnBytes(columnIndex: number, callback: CsvColumnBytesCallback, startRow?: number, endRow?: number): void;
  scanColumns(columns: CsvColumns, callback: CsvScanColumnsCallback, startRow?: number, endRow?: number): void;
}

export type CsvColumnarBatchCallback = (batch: CsvColumnarBatchView, batchIndex: number) => void;
