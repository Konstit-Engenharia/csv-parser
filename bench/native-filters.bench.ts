import { measure } from 'mitata';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import {
  countCsvFileWhereIn,
  countCsvFileWhereStartsWith,
  NativeCsvParser,
  parseCsvFileProjected,
} from '../src/index.ts';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const FILTER_COLUMN = Number(Bun.env['CSV_BENCH_FILTER_COLUMN'] ?? 19);
const FILTER_VALUES = (Bun.env['CSV_BENCH_FILTER_VALUES'] ?? 'SP,RJ')
  .split(',')
  .filter((value) => value.length > 0);
const FILTER_PREFIX = Bun.env['CSV_BENCH_FILTER_PREFIX'] ?? 'S';
const SELECTED_COLUMNS = [FILTER_COLUMN];
const bytes = statSync(FILE).size;

const filterSet = new Set(FILTER_VALUES);

const cases = [
  ['js materialized selected column filter in', () => countJsMaterializedSelectedIn()],
  ['js projected selected column filter in', () => countJsProjectedIn()],
  ['native filter in', () =>
    countCsvFileWhereIn(FILE, FILTER_COLUMN, FILTER_VALUES, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
    })],
  ['js materialized selected column startsWith', () => countJsMaterializedSelectedStartsWith()],
  ['js projected selected column startsWith', () => countJsProjectedStartsWith()],
  ['native filter startsWith', () =>
    countCsvFileWhereStartsWith(FILE, FILTER_COLUMN, FILTER_PREFIX, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
    })],
] as const;

console.log(JSON.stringify({
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  filterColumn: FILTER_COLUMN,
  filterValues: FILTER_VALUES,
  filterPrefix: FILTER_PREFIX,
}));

for (const [name, fn,] of cases) {
  let rows = 0;
  const stats = await measure(async () => {
    rows = await fn();
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
    rows,
    seconds,
    mibPerSecond,
  }));
}

async function countJsMaterializedSelectedIn(): Promise<number> {
  return countJsMaterializedSelected((value) => filterSet.has(value));
}

async function countJsMaterializedSelectedStartsWith(): Promise<number> {
  return countJsMaterializedSelected((value) => value.startsWith(FILTER_PREFIX));
}

async function countJsMaterializedSelected(predicate: (value: string) => boolean): Promise<number> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        rows += countRowsMatching(batch.rowsInto(rowsBuffer, SELECTED_COLUMNS), predicate);
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      rows += countRowsMatching(batch.rowsInto(rowsBuffer, SELECTED_COLUMNS), predicate);
    } finally {
      batch.close();
    }
    return rows;
  } finally {
    parser.close();
  }
}

async function countJsProjectedIn(): Promise<number> {
  return countJsProjected((value) => filterSet.has(value));
}

async function countJsProjectedStartsWith(): Promise<number> {
  return countJsProjected((value) => value.startsWith(FILTER_PREFIX));
}

async function countJsProjected(predicate: (value: string) => boolean): Promise<number> {
  let rows = 0;
  for await (
    const batch of parseCsvFileProjected(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      selectedColumns: SELECTED_COLUMNS,
    })
  ) {
    try {
      rows += countRowsMatching(batch, predicate);
    } finally {
      for (const row of batch) {
        row.length = 0;
      }
    }
  }
  return rows;
}

function countRowsMatching(rows: readonly string[][], predicate: (value: string) => boolean): number {
  let count = 0;
  for (const row of rows) {
    if (predicate(row[0] ?? '')) {
      ++count;
    }
  }
  return count;
}
