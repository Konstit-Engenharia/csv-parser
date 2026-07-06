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
