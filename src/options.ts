import type {
  CsvColumnarBatchOptions,
  CsvColumns,
  CsvCountOptions,
  CsvRowsOptions,
  CsvRowViewsOptions,
} from './types.js';

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
