import type { NativeCsvRowView } from './batches.ts';

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

export type NativeCsvRowCallback = (row: NativeCsvRowView, rowIndex: number) => void;
