/**
 * Shared operator-controlled configuration for the examples.
 *
 * Example-specific variables take precedence over benchmark variables so the
 * demos can be pointed at a different file without changing benchmark setup.
 * These values cross an environment boundary; the public API performs final
 * validation when an operation starts.
 */
export const FILE = Bun.env['CSV_EXAMPLE_FILE'] ?? Bun.env['CSV_BENCH_FILE'] ?? 'corpus/large/example.csv';
export const DELIMITER = Bun.env['CSV_EXAMPLE_DELIMITER'] ?? Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
// LIMIT affects printing only. It does not cap parsing work for APIs that lack
// cooperative early termination, such as a synchronous per-batch callback.
export const LIMIT = Number(Bun.env['CSV_EXAMPLE_LIMIT'] ?? Bun.env['CSV_PRINT_ROWS'] ?? 10);
// Eight MiB is a read-size default, not a maximum record or file size.
export const CHUNK_SIZE = Number(Bun.env['CSV_EXAMPLE_CHUNK_SIZE'] ?? Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
// Column indexes are zero-based physical positions. The public contract rejects
// duplicates, indexes above 2024, and projections longer than 2024 entries.
export const COLUMNS = parseColumns(Bun.env['CSV_EXAMPLE_COLUMNS']) ?? [0, 1, 2];
export const FILTER_COLUMN = Number(Bun.env['CSV_EXAMPLE_FILTER_COLUMN'] ?? COLUMNS[0] ?? 0);
// Leaving the value absent disables filtering in examples that support it.
export const FILTER_VALUE = Bun.env['CSV_EXAMPLE_FILTER_VALUE'];
export function parseColumns(value: string | undefined): number[] | undefined {
  // Treat a missing or whitespace-only variable as "use the example default".
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  // This helper gives a configuration-specific error for the basic numeric
  // shape. The API applies its authoritative uniqueness, length, and upper-bound
  // checks before native code receives the projection.
  const columns = value.split(',').map((part) => Number(part.trim()));
  if (columns.some((column) => !Number.isInteger(column) || column < 0)) {
    throw new Error(`invalid CSV_EXAMPLE_COLUMNS: ${value}`);
  }
  // Environment configuration is trusted operator input in these examples. Do
  // not expose arbitrary request-provided column lists without an application
  // allowlist, even though the parser enforces its resource bounds.
  return columns;
}
