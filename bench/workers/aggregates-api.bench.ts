import { measure } from 'mitata';
import { csv } from '../../src/index.ts';
import type { CsvColumns, CsvGroupByCountEntry } from '../../src/types.ts';
import { fileSize } from './common.ts';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

interface GroupByBenchResult {
  checksum: string;
  dictionaryCount: number;
  rowCount: number;
  totalCount: number;
}

interface MultiColumnBenchResult {
  checksum: string;
  columns: GroupByBenchResult[];
  rowCount: number;
  totalDictionaries: number;
}

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = parsePositiveInt(Bun.env['CSV_BENCH_CHUNK_SIZE'], 8 * 1024 * 1024, 'CSV_BENCH_CHUNK_SIZE');
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const WORKERS = parsePositiveInt(Bun.env['CSV_WORKERS'] ?? Bun.env['CSV_BENCH_WORKERS'], 4, 'CSV_WORKERS');
const GROUP_BY_COLUMN = parseNonNegativeInt(Bun.env['CSV_BENCH_GROUPBY_COLUMN'], 19, 'CSV_BENCH_GROUPBY_COLUMN');
const MULTI_COLUMNS = parseColumns(Bun.env['CSV_BENCH_MULTI_COLUMNS'] ?? '2,19,21');
const BYTES = fileSize(FILE);

console.log(JSON.stringify({
  bytes: BYTES,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  file: FILE,
  groupByColumn: GROUP_BY_COLUMN,
  multiColumns: MULTI_COLUMNS,
  workers: WORKERS,
}));

const serialGroupBy = await runBenchCase('serial groupByCount', runSerialGroupByCount, projectGroupByResult);
const workerGroupBy = await runBenchCase('workers groupByCount', runWorkerGroupByCount, projectGroupByResult);
validateGroupBy(serialGroupBy, workerGroupBy);

const serialMulti = await runBenchCase('serial multiColumnStats', runSerialMultiColumnStats, projectMultiColumnResult);
const workerMulti = await runBenchCase('workers multiColumnStats', runWorkerMultiColumnStats, projectMultiColumnResult);
validateMulti(serialMulti, workerMulti);

async function runSerialGroupByCount(): Promise<GroupByBenchResult> {
  const batch = await csv.file(FILE)
    .delimiter(DELIMITER)
    .chunkSize(CHUNK_SIZE)
    .groupByCount(GROUP_BY_COLUMN);
  try {
    return summarizeEntries(batch.rowCount, batch.entries());
  } finally {
    batch.close();
  }
}

async function runWorkerGroupByCount(): Promise<GroupByBenchResult> {
  const batch = await csv.file(FILE)
    .delimiter(DELIMITER)
    .chunkSize(CHUNK_SIZE)
    .workers(WORKERS)
    .groupByCount(GROUP_BY_COLUMN);
  try {
    return summarizeEntries(batch.rowCount, batch.entries());
  } finally {
    batch.close();
  }
}

async function runSerialMultiColumnStats(): Promise<MultiColumnBenchResult> {
  const batches = await csv.file(FILE)
    .delimiter(DELIMITER)
    .chunkSize(CHUNK_SIZE)
    .multiColumnStats(MULTI_COLUMNS);
  try {
    return summarizeMultiColumn(
      batches.map((batch, index) => ({
        column: batch.column ?? MULTI_COLUMNS[index] ?? -1,
        entries: batch.entries(),
        rowCount: batch.rowCount,
      })),
    );
  } finally {
    for (const batch of batches) {
      batch.close();
    }
  }
}

async function runWorkerMultiColumnStats(): Promise<MultiColumnBenchResult> {
  const batches = await csv.file(FILE)
    .delimiter(DELIMITER)
    .chunkSize(CHUNK_SIZE)
    .workers(WORKERS)
    .multiColumnStats(MULTI_COLUMNS);
  try {
    return summarizeMultiColumn(
      batches.map((batch, index) => ({
        column: batch.column ?? MULTI_COLUMNS[index] ?? -1,
        entries: batch.entries(),
        rowCount: batch.rowCount,
      })),
    );
  } finally {
    for (const batch of batches) {
      batch.close();
    }
  }
}

async function runBenchCase<TResult>(
  name: string,
  fn: () => Promise<TResult>,
  project: (result: TResult) => Record<string, unknown>,
): Promise<TResult> {
  let result!: TResult;
  const stats = await measure(async () => {
    result = await fn();
  }, {
    max_samples: 1,
    min_cpu_time: 0,
    min_samples: 1,
    warmup_samples: 0,
  });

  const seconds = stats.avg / 1e9;
  console.log(JSON.stringify({
    mibPerSecond: BYTES / 1024 / 1024 / seconds,
    name,
    seconds,
    ...project(result),
  }));
  return result;
}

function summarizeEntries(rowCount: number, entries: readonly CsvGroupByCountEntry[]): GroupByBenchResult {
  const sorted = [...entries].sort((left, right) => left.value.localeCompare(right.value));
  let hash = FNV_OFFSET;
  let totalCount = 0;
  for (const entry of sorted) {
    totalCount += entry.count;
    hash = hashValue(hash, entry.value);
    hash = hashValue(hash, '\u0000');
    hash = hashValue(hash, String(entry.count));
    hash = hashValue(hash, '\n');
  }
  return {
    checksum: hashHex(hash),
    dictionaryCount: sorted.length,
    rowCount,
    totalCount,
  };
}

function summarizeMultiColumn(columns: Array<{
  column: number;
  entries: readonly CsvGroupByCountEntry[];
  rowCount: number;
}>): MultiColumnBenchResult {
  const summaries = columns
    .map((column) => ({
      column: column.column,
      summary: summarizeEntries(column.rowCount, column.entries),
    }))
    .sort((left, right) => left.column - right.column);

  let checksum = FNV_OFFSET;
  let totalDictionaries = 0;
  for (let index = 0; index < summaries.length; ++index) {
    const column = summaries[index]!;
    const summary = column.summary;
    totalDictionaries += summary.dictionaryCount;
    checksum = hashValue(checksum, `${column.column}\u0000${summary.checksum}\n`);
  }

  return {
    checksum: hashHex(checksum),
    columns: summaries.map((column) => column.summary),
    rowCount: summaries[0]?.summary.rowCount ?? 0,
    totalDictionaries,
  };
}

function projectGroupByResult(result: GroupByBenchResult): Record<string, unknown> {
  return {
    checksum: result.checksum,
    dictionaryCount: result.dictionaryCount,
    rowCount: result.rowCount,
    totalCount: result.totalCount,
  };
}

function projectMultiColumnResult(result: MultiColumnBenchResult): Record<string, unknown> {
  return {
    checksum: result.checksum,
    columns: result.columns.map((column) => ({
      checksum: column.checksum,
      dictionaryCount: column.dictionaryCount,
      rowCount: column.rowCount,
      totalCount: column.totalCount,
    })),
    rowCount: result.rowCount,
    totalDictionaries: result.totalDictionaries,
  };
}

function validateGroupBy(serial: GroupByBenchResult, workers: GroupByBenchResult): void {
  const equal = serial.rowCount === workers.rowCount
    && serial.totalCount === workers.totalCount
    && serial.dictionaryCount === workers.dictionaryCount
    && serial.checksum === workers.checksum;
  console.log(JSON.stringify({ equal, kind: 'groupByCount' }));
  if (!equal) {
    throw new Error('groupByCount serial/workers mismatch');
  }
}

function validateMulti(serial: MultiColumnBenchResult, workers: MultiColumnBenchResult): void {
  const equal = serial.rowCount === workers.rowCount
    && serial.totalDictionaries === workers.totalDictionaries
    && serial.checksum === workers.checksum
    && serial.columns.length === workers.columns.length
    && serial.columns.every((column, index) => {
      const other = workers.columns[index];
      return other !== undefined
        && column.rowCount === other.rowCount
        && column.totalCount === other.totalCount
        && column.dictionaryCount === other.dictionaryCount
        && column.checksum === other.checksum;
    });
  console.log(JSON.stringify({ equal, kind: 'multiColumnStats' }));
  if (!equal) {
    throw new Error('multiColumnStats serial/workers mismatch');
  }
}

function parseColumns(value: string): CsvColumns {
  const columns = value
    .split(',')
    .filter((item) => item.trim() !== '')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
  if (columns.length === 0) {
    throw new Error('CSV_BENCH_MULTI_COLUMNS must contain at least one column');
  }
  return columns;
}

function parsePositiveInt(rawValue: string | undefined, fallback: number, name: string): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be positive integer: ${rawValue ?? fallback}`);
  }
  return value;
}

function parseNonNegativeInt(rawValue: string | undefined, fallback: number, name: string): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be non-negative integer: ${rawValue ?? fallback}`);
  }
  return value;
}

function hashValue(seed: bigint, value: string): bigint {
  let hash = seed;
  const bytes = Buffer.from(value, 'utf8');
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & FNV_MASK;
  }
  return hash;
}

function hashHex(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}
