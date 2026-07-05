import { measure } from 'mitata';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import { NativeCsvParser } from '../src/index.ts';

const GENERATED_ROWS = Number(Bun.env['CSV_BENCH_GENERATED_ROWS'] ?? 5_000_000);
const FILE = Bun.env['CSV_BENCH_FILE'] ?? await generateFixture(GENERATED_ROWS);
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const FIXED_COLUMNS = Number(Bun.env['CSV_BENCH_FIXED_COLUMNS'] ?? await inferFixedColumns(FILE, DELIMITER));
const bytes = statSync(FILE).size;

const cases = [
  ['native batch parser', () => countRows(false)],
  ['native fixed-column batch parser', () => countRows('fixed')],
  ['native trusted fixed batch parser', () => countRows('trusted')],
] as const;

console.log(JSON.stringify({
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  fixedColumns: FIXED_COLUMNS,
}));

for (const [name, fn,] of cases) {
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
  const mibPerSecond = bytes / 1024 / 1024 / seconds;

  console.log(JSON.stringify({
    name,
    rows,
    seconds,
    mibPerSecond,
  }));
}

async function countRows(mode: false | 'fixed' | 'trusted'): Promise<number> {
  const parser = new NativeCsvParser({
    delimiter: DELIMITER,
    fixedColumns: mode === 'fixed' ? FIXED_COLUMNS : undefined,
    trusted: mode === 'trusted'
      ? {
        fixedColumns: FIXED_COLUMNS,
        noNewlinesInQuotes: true,
      }
      : undefined,
  });
  let rows = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        rows += batch.rowCount;
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      rows += batch.rowCount;
    } finally {
      batch.close();
    }
    return rows;
  } finally {
    parser.close();
  }
}

async function inferFixedColumns(path: string, delimiter: string): Promise<number> {
  const file = Bun.file(path);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let line = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      const newline = text.indexOf('\n');
      if (newline >= 0) {
        line += text.slice(0, newline).replace(/\r$/, '');
        break;
      }
      line += text;
    }
  } finally {
    reader.releaseLock();
  }
  return countCsvColumns(line, delimiter);
}

async function generateFixture(rows: number): Promise<string> {
  const path = `/tmp/csv-trusted-fixed-${rows}.csv`;
  const writer = Bun.file(path).writer();
  for (let row = 0; row < rows; ++row) {
    void writer.write(`${row};Ana${row % 10};SP\n`);
  }
  await writer.end();
  return path;
}

function countCsvColumns(row: string, delimiter: string): number {
  if (row.length === 0) {
    return 0;
  }
  let columns = 1;
  let inQuotes = false;
  for (let index = 0; index < row.length; ++index) {
    const char = row[index];
    if (char === '"') {
      if (inQuotes && row[index + 1] === '"') {
        ++index;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && char === delimiter) {
      ++columns;
    }
  }
  return columns;
}
