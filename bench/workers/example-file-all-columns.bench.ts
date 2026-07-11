import { measure } from 'mitata';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import {
  csv,
  NativeCsvParser,
} from '../../src/index.ts';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);
const bytes = statSync(FILE).size;

console.log(JSON.stringify({
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  file: FILE,
  workers: WORKERS,
}));

const cases = [
  ['native single-thread materialize all columns', () => materializeSingleThread()],
  ['native workers materialize all columns', () => materializeWorkers()],
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
  console.log(JSON.stringify({
    cells,
    chars,
    mibPerSecond: bytes / 1024 / 1024 / seconds,
    name,
    rows,
    seconds,
  }));
}

async function materializeSingleThread(): Promise<{ cells: number; chars: number; rows: number; }> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  let cells = 0;
  let chars = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        const materialized = batch.rowsInto(rowsBuffer);
        rows += materialized.length;
        for (const row of materialized) {
          cells += row.length;
          for (const value of row) {
            chars += value.length;
          }
        }
      } finally {
        batch.close();
      }
    }

    const batch = parser.endBatch();
    try {
      const materialized = batch.rowsInto(rowsBuffer);
      rows += materialized.length;
      for (const row of materialized) {
        cells += row.length;
        for (const value of row) {
          chars += value.length;
        }
      }
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }

  return {
    cells,
    chars,
    rows,
  };
}

async function materializeWorkers(): Promise<{ cells: number; chars: number; rows: number; }> {
  using pool = csv.file(FILE)
    .delimiter(DELIMITER)
    .chunkSize(CHUNK_SIZE)
    .workers(WORKERS)
    .pool();

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
