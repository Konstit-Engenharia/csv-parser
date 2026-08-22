if (!process.versions.bun) {
  throw new Error('This package requires Bun');
}

export type {
  CsvApiFileOptions,
  CsvBatchesOptions,
  CsvColumnarBatchCallback,
  CsvColumnarBatchOptions,
  CsvColumnarBatchView,
  CsvColumnBytesCallback,
  CsvColumnRangeCallback,
  CsvColumns,
  CsvColumnSelection,
  CsvCompression,
  CsvCountOptions,
  CsvDelimiter,
  CsvEncoding,
  CsvEqualsFilter,
  CsvFieldRange,
  CsvFieldValue,
  CsvFileOptions,
  CsvInFilter,
  CsvNativeFilter,
  CsvNativeProjectionOptions,
  CsvParallelCountOptions,
  CsvParallelRowsOptions,
  CsvParseOptions,
  CsvParserOptions,
  CsvProjectedRow,
  CsvRow,
  CsvRowsOptions,
  CsvRowView,
  CsvRowViewCallback,
  CsvRowViewsOptions,
  CsvScanColumnsCallback,
  CsvShard,
  CsvShardingOptions,
  CsvSingleThreadRowsOptions,
  CsvStartsWithFilter,
  CsvWhereAllFilter,
  CsvWhereEqualsFilter,
  CsvWhereFilter,
  CsvWhereInFilter,
  CsvWherePredicate,
  CsvWhereStartsWithFilter,
  CsvWorkerPoolOptions,
  CsvZipCompression,
  NativeCsvRowCallback,
} from './types.ts';

export {
  csv,
  CsvWorkerPool,
  findCsvSafeShards,
  findCsvSafeSplitOffsets,
  forEachColumnarBatches,
  forEachRowViews,
  parallelCount,
  parallelRows,
  withColumnarBatches,
  withRowViews,
  workerPool,
} from './api.ts';
export { NativeCsvBatch, NativeCsvRowView } from './batches.ts';
export { countCsvFile, countTrustedNewlineRows, parseCsvBuffer, parseCsvFile, parseCsvFileProjected } from './files.ts';
export { defineColumnarOptions, defineCountOptions, defineRowsOptions, defineRowViewOptions } from './options.ts';
export { NativeCsvParser } from './parser.ts';
