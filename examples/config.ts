export const FILE = Bun.env['CSV_EXAMPLE_FILE'] ?? Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
export const DELIMITER = Bun.env['CSV_EXAMPLE_DELIMITER'] ?? Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
export const LIMIT = Number(Bun.env['CSV_EXAMPLE_LIMIT'] ?? Bun.env['CSV_PRINT_ROWS'] ?? 10);
export const CHUNK_SIZE = Number(Bun.env['CSV_EXAMPLE_CHUNK_SIZE'] ?? Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
export const COLUMNS = parseColumns(Bun.env['CSV_EXAMPLE_COLUMNS']) ?? [0, 1, 2];
export const FILTER_COLUMN = Number(Bun.env['CSV_EXAMPLE_FILTER_COLUMN'] ?? COLUMNS[0] ?? 0);
export const FILTER_VALUE = Bun.env['CSV_EXAMPLE_FILTER_VALUE'];
export const GROUP_COLUMN = Number(Bun.env['CSV_EXAMPLE_GROUP_COLUMN'] ?? COLUMNS[0] ?? 0);

export function parseColumns(value: string | undefined): number[] | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const columns = value.split(',').map((part) => Number(part.trim()));
  if (columns.some((column) => !Number.isInteger(column) || column < 0)) {
    throw new Error(`invalid CSV_EXAMPLE_COLUMNS: ${value}`);
  }
  return columns;
}
