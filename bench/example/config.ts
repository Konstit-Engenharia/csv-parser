import { measure } from 'mitata';
import { statSync } from 'node:fs';
import { matchesBenchmarkName } from '../benchmark-filter.ts';

export type ExampleBenchCase = readonly [name: string, fn: () => Promise<number> | number];

export const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
export const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
export const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
export const SELECTED_COLUMNS = parseColumns(Bun.env['CSV_BENCH_COLUMNS'] ?? '0,4,19');
export const FILTER_COLUMN = Number(Bun.env['CSV_BENCH_FILTER_COLUMN'] ?? 19);
export const FILTER_VALUE = Bun.env['CSV_BENCH_FILTER_VALUE'] ?? 'SP';
export const BYTES = statSync(FILE).size;

export async function runExampleBenchCases(cases: readonly ExampleBenchCase[]): Promise<void> {
  console.log({
    file: FILE,
    bytes: BYTES,
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    selectedColumns: SELECTED_COLUMNS,
    filterColumn: FILTER_COLUMN,
    filterValue: FILTER_VALUE,
  });

  for (const [name, fn,] of cases) {
    if (!matchesBenchmarkName(name)) {
      continue;
    }

    let rows = 0;
    const stats = await measure(async () => {
      rows = await fn();
      if (rows === 0) {
        throw new Error(`${name}: zero rows`);
      }
    }, {
      min_samples: 1,
      max_samples: 1,
      min_cpu_time: 0,
      warmup_samples: 0,
    });

    const seconds = stats.avg / 1e9;
    const mibPerSecond = BYTES / 1024 / 1024 / seconds;

    console.log({
      name,
      rows,
      seconds,
      mibPerSecond,
    });
  }
}

function parseColumns(value: string): number[] {
  return value
    .split(',')
    .filter((item) => item.trim() !== '')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
}
