import {
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  countCsvFile,
  countCsvFileWhereEquals,
  parseCsvBuffer,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';

const ROWS = 25_000;
const EXPECTED_ROWS = ROWS + 1;
const MAX_COUNT_MS = 3_000;
const MAX_MATERIALIZE_MS = 6_000;
const MAX_STREAM_MS = 6_000;

function makeCsv(rows: number): Buffer {
  const lines = ['id,nome,cidade,status,valor'];
  for (let i = 0; i < rows; ++i) {
    const status = i % 10 === 0 ? 'hot' : 'cold';
    lines.push(`${i},Joao ${i},"Sao Paulo, SP",${status},${i % 997}`);
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertUnder(milliseconds: number, maxMilliseconds: number, label: string): void {
  if (milliseconds > maxMilliseconds) {
    throw new Error(`${label}: ${milliseconds.toFixed(1)}ms > ${maxMilliseconds}ms`);
  }
}

async function measure<T>(label: string, maxMilliseconds: number, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  assertUnder(elapsed, maxMilliseconds, label);
  console.log(`${label}: ${elapsed.toFixed(1)}ms`);
  return result;
}

async function collectRows(path: string): Promise<number> {
  let count = 0;
  for await (const batch of parseCsvFile(path, { chunkSize: 4_096 })) {
    count += batch.length;
  }
  return count;
}

async function collectProjectedHotRows(path: string): Promise<number> {
  let count = 0;
  for await (
    const batch of parseCsvFileProjected(path, {
      chunkSize: 4_096,
      selectedColumns: [0, 3],
      equalsFilter: { column: 3, value: 'hot' },
    })
  ) {
    count += batch.length;
  }
  return count;
}

const csv = makeCsv(ROWS);
const tempDir = await mkdtemp(join(tmpdir(), 'csv-parser-smoke-'));
const csvPath = join(tempDir, 'smoke.csv');

try {
  await writeFile(csvPath, csv);

  const rows = await measure('materialize buffer', MAX_MATERIALIZE_MS, () => parseCsvBuffer(csv));
  assertEqual(rows.length, EXPECTED_ROWS, 'materialized row count');
  assertEqual(rows[0]?.[0], 'id', 'header first column');
  assertEqual(rows[1]?.[2], 'Sao Paulo, SP', 'quoted field');
  assertEqual(rows[ROWS]?.[4], String((ROWS - 1) % 997), 'last value');

  const count = await measure('count file', MAX_COUNT_MS, () => countCsvFile(csvPath, { chunkSize: 4_096 }));
  assertEqual(count, EXPECTED_ROWS, 'countCsvFile row count');

  const hotCount = await countCsvFileWhereEquals(csvPath, 3, 'hot', { chunkSize: 4_096 });
  assertEqual(hotCount, ROWS / 10, 'countCsvFileWhereEquals hot row count');

  const streamedCount = await measure('stream materialize file', MAX_STREAM_MS, () => collectRows(csvPath));
  assertEqual(streamedCount, EXPECTED_ROWS, 'parseCsvFile row count');

  const projectedHotCount = await collectProjectedHotRows(csvPath);
  assertEqual(projectedHotCount, ROWS / 10, 'parseCsvFileProjected hot row count');

  console.log(`smoke ok: ${ROWS} synthetic data rows`);
} finally {
  await rm(tempDir, {
    force: true,
    recursive: true,
  });
}
