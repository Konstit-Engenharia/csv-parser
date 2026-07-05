import { measure } from 'mitata';
import { statSync } from 'node:fs';
import {
  parseCsvFileColumnStats,
  parseCsvFileMultiColumnStats,
} from '../src/index.ts';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const COLUMNS = (Bun.env['CSV_BENCH_COLUMNS'] ?? '0,4,19')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);
const bytes = statSync(FILE).size;

const cases = [
  ['native column stats separate passes', countSeparateColumnStats],
  ['native multi-column stats one pass', countMultiColumnStats],
] as const;

console.log(JSON.stringify({
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  columns: COLUMNS,
}));

for (const [name, fn,] of cases) {
  let result: ColumnStatsBenchResult = {
    rows: 0,
    dictionaries: 0,
  };
  const stats = await measure(async () => {
    result = await fn();
    if (result.rows === 0) {
      throw new Error(`${name}: zero rows`);
    }
  }, {
    min_samples: 1,
    max_samples: 1,
    min_cpu_time: 0,
    warmup_samples: 0,
  });

  const seconds = stats.avg / 1e9;
  const mibPerSecond = bytes / 1024 / 1024 / seconds;

  console.log(JSON.stringify({
    name,
    rows: result.rows,
    dictionaries: result.dictionaries,
    seconds,
    mibPerSecond,
  }));
}

interface ColumnStatsBenchResult {
  rows: number;
  dictionaries: number;
}

async function countSeparateColumnStats(): Promise<ColumnStatsBenchResult> {
  let rows = 0;
  let dictionaries = 0;
  for (const column of COLUMNS) {
    const batch = await parseCsvFileColumnStats(FILE, column, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
    });
    try {
      rows += batch.rowCount;
      dictionaries += batch.dictionaryCount;
    } finally {
      batch.close();
    }
  }
  return {
    rows,
    dictionaries,
  };
}

async function countMultiColumnStats(): Promise<ColumnStatsBenchResult> {
  const batches = await parseCsvFileMultiColumnStats(FILE, COLUMNS, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
  });
  try {
    return batches.reduce<ColumnStatsBenchResult>((result, batch) => {
      result.rows += batch.rowCount;
      result.dictionaries += batch.dictionaryCount;
      return result;
    }, {
      rows: 0,
      dictionaries: 0,
    });
  } finally {
    for (const batch of batches) {
      batch.close();
    }
  }
}
