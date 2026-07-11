import type {
  CsvAggregateOptions,
  CsvColumnarBatchOptions,
  CsvColumns,
  CsvCountOptions,
  CsvDictionaryOptions,
  CsvRowsOptions,
  CsvRowViewsOptions,
} from './types.ts';

/**
 * Preserve literal inference for `csv.rows()` options.
 */
export function defineRowsOptions<
  const TColumns extends CsvColumns | undefined,
  const TOptions extends CsvRowsOptions<TColumns>,
>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal inference for `csv.count()` options.
 */
export function defineCountOptions<const TOptions extends CsvCountOptions>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal inference for `csv.withColumnarBatches()` options.
 */
export function defineColumnarOptions<
  const TColumns extends CsvColumns | undefined,
  const TOptions extends CsvColumnarBatchOptions<TColumns>,
>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal inference for `csv.withRowViews()` options.
 */
export function defineRowViewOptions<
  const TColumns extends CsvColumns | undefined,
  const TOptions extends CsvRowViewsOptions<TColumns>,
>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal inference for aggregate options.
 */
export function defineAggregateOptions<const TOptions extends CsvAggregateOptions>(options: TOptions): TOptions {
  return options;
}

/**
 * Preserve literal inference for dictionary options.
 */
export function defineDictionaryOptions<const TOptions extends CsvDictionaryOptions>(options: TOptions): TOptions {
  return options;
}
