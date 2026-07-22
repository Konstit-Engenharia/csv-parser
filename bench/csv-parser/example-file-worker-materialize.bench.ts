import { measure } from 'mitata';
import { statSync } from 'node:fs';
import { csv } from '../../src/index.ts';
import { materializeFileWithCsvParser } from './common.ts';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);
const bytes = statSync(FILE).size;

console.log({
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  file: FILE,
  workers: WORKERS,
});

const cases = [
  ['native workers materialize all columns', () => materializeNativeWorkers()],
  ['iconv-lite latin1 + csv-parser materialize all columns', () => materializeCsvParser()],
] as const;

for (const [name, fn,] of cases) {
  let rows = 0;
  let cells = 0;
  let chars = 0;
  const stats = await measure(async () => {
    const result = await fn();
    rows = result.rows;
    cells = result.cells;
    chars = result.chars;
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
  console.log({
    cells,
    chars,
    mibPerSecond: bytes / 1024 / 1024 / seconds,
    name,
    rows,
    seconds,
  });
}

async function materializeNativeWorkers(): Promise<{ cells: number; chars: number; rows: number; }> {
  using pool = csv.workerPool(FILE, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    workerCount: WORKERS,
  });

  let rows = 0;
  let cells = 0;
  let chars = 0;
  for await (const batch of pool.rows()) {
    rows += batch.length;
    for (const row of batch) {
      cells += row.length;
      for (const value of row) {
        chars += value.length;
      }
    }
  }
  return {
    cells,
    chars,
    rows,
  };
}

function materializeCsvParser(): Promise<{ cells: number; chars: number; rows: number; }> {
  return materializeFileWithCsvParser(FILE, CHUNK_SIZE, DELIMITER, 'latin1');
}
