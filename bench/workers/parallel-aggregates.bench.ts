import { measure } from 'mitata';
import {
  createNativeCsvColumnStatsBatch,
  createNativeCsvGroupByCountBatch,
  type NativeCsvColumnStatsBatch,
  type NativeCsvGroupByCountBatch,
} from '../../src/batches.ts';
import {
  columnStats,
  groupByCount,
} from '../../src/index.ts';
import {
  buildNativeCsvSafeShards,
  fileSize,
  inferFixedColumns,
  type TrustedShard,
} from './common.ts';

interface GroupByBenchResult {
  rowCount: number;
  totalCount: number;
  dictionaryCount: number;
  checksum: string;
  top: Array<readonly [value: string, count: number]>;
}

interface ColumnStatsBenchResult {
  column: number;
  rowCount: number;
  totalCount: number;
  dictionaryCount: number;
  checksum: string;
  top: Array<readonly [value: string, count: number]>;
}

interface BaseWorkerRunMessage {
  chunkSize: number;
  delimiter: string;
  fixedColumns: number;
  path: string;
  shard: TrustedShard;
  workerIndex: number;
}

interface GroupByCountWorkerRunMessage extends BaseWorkerRunMessage {
  kind: 'groupByCount';
  column: number;
}

interface ColumnStatsWorkerRunMessage extends BaseWorkerRunMessage {
  kind: 'columnStats';
  column: number;
}

type WorkerRunMessage = GroupByCountWorkerRunMessage | ColumnStatsWorkerRunMessage;

interface GroupByCountBatchParts {
  counts: BigUint64Array;
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array;
  rowCount: number;
}

interface ColumnStatsBatchParts {
  column: number;
  counts: BigUint64Array;
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array;
  ids: Uint32Array;
}

interface GroupByCountWorkerDoneMessage {
  type: 'done';
  kind: 'groupByCount';
  workerIndex: number;
  batch: GroupByCountBatchParts;
}

interface ColumnStatsWorkerDoneMessage {
  type: 'done';
  kind: 'columnStats';
  workerIndex: number;
  batch: ColumnStatsBatchParts;
}

interface WorkerErrorMessage {
  type: 'error';
  error: string;
  workerIndex: number;
}

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = parsePositiveInt(Bun.env['CSV_BENCH_CHUNK_SIZE'], 8 * 1024 * 1024, 'CSV_BENCH_CHUNK_SIZE');
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const WORKERS = parsePositiveInt(Bun.env['CSV_BENCH_WORKERS'], 4, 'CSV_BENCH_WORKERS');
const GROUP_BY_COLUMN = parseNonNegativeInt(Bun.env['CSV_BENCH_GROUPBY_COLUMN'], 19, 'CSV_BENCH_GROUPBY_COLUMN');
const STATS_COLUMN = parseNonNegativeInt(Bun.env['CSV_BENCH_STATS_COLUMN'], 19, 'CSV_BENCH_STATS_COLUMN');
const FIXED_COLUMNS = parsePositiveInt(
  Bun.env['CSV_BENCH_FIXED_COLUMNS'],
  await inferFixedColumns(FILE, DELIMITER),
  'CSV_BENCH_FIXED_COLUMNS',
);
const BYTES = fileSize(FILE);
const SHARDS = buildNativeCsvSafeShards(FILE, WORKERS, DELIMITER);
const TRUSTED = {
  fixedColumns: FIXED_COLUMNS,
  noNewlinesInQuotes: true,
} as const;

console.log(JSON.stringify({
  bytes: BYTES,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  file: FILE,
  fixedColumns: FIXED_COLUMNS,
  groupByColumn: GROUP_BY_COLUMN,
  requestedWorkers: WORKERS,
  shardCount: SHARDS.length,
  statsColumn: STATS_COLUMN,
}));

const serialGroupBy = await runBenchCase('serial groupByCount', runSerialGroupByCount, projectGroupByResult);
const workerGroupBy = await runBenchCase('workers groupByCount', runWorkerGroupByCount, projectGroupByResult);
logGroupByValidation(serialGroupBy, workerGroupBy);

const serialColumnStats = await runBenchCase('serial columnStats', runSerialColumnStats, projectColumnStatsResult);
const workerColumnStats = await runBenchCase('workers columnStats', runWorkerColumnStats, projectColumnStatsResult);
logColumnStatsValidation(serialColumnStats, workerColumnStats);

async function runBenchCase<TResult>(
  name: string,
  fn: () => Promise<TResult>,
  project: (result: TResult) => Record<string, unknown>,
): Promise<TResult> {
  let result!: TResult;
  const stats = await measure(async () => {
    result = await fn();
  }, {
    min_samples: 1,
    max_samples: 1,
    min_cpu_time: 0,
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

async function runSerialGroupByCount(): Promise<GroupByBenchResult> {
  const batch = await groupByCount(FILE, GROUP_BY_COLUMN, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    trusted: TRUSTED,
  });
  try {
    return summarizeGroupByBatch(batch);
  } finally {
    batch.close();
  }
}

async function runWorkerGroupByCount(): Promise<GroupByBenchResult> {
  const batch = await parallelGroupByCountBatchLocal();
  try {
    return summarizeGroupByBatch(batch);
  } finally {
    batch.close();
  }
}

async function runSerialColumnStats(): Promise<ColumnStatsBenchResult> {
  const batch = await columnStats(FILE, STATS_COLUMN, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    trusted: TRUSTED,
  });
  try {
    return summarizeColumnStatsBatch(batch);
  } finally {
    batch.close();
  }
}

async function runWorkerColumnStats(): Promise<ColumnStatsBenchResult> {
  const batch = await parallelColumnStatsBatchLocal();
  try {
    return summarizeColumnStatsBatch(batch);
  } finally {
    batch.close();
  }
}

async function parallelGroupByCountBatchLocal(): Promise<NativeCsvGroupByCountBatch> {
  if (SHARDS.length === 0) {
    return createNativeCsvGroupByCountBatch({
      counts: [],
      dictionaryData: new Uint8Array(0),
      dictionaryOffsets: [0n],
      rowCount: 0,
    });
  }

  const messages = await runWorkers<GroupByCountWorkerDoneMessage>({
    createMessage(shard, workerIndex) {
      return {
        chunkSize: CHUNK_SIZE,
        column: GROUP_BY_COLUMN,
        delimiter: DELIMITER,
        fixedColumns: FIXED_COLUMNS,
        kind: 'groupByCount',
        path: FILE,
        shard,
        workerIndex,
      };
    },
  });

  const shardBatches = messages.map((message) => createNativeCsvGroupByCountBatch(message.batch));
  try {
    return mergeGroupByCountBatches(shardBatches);
  } finally {
    for (const batch of shardBatches) {
      batch.close();
    }
  }
}

async function parallelColumnStatsBatchLocal(): Promise<NativeCsvColumnStatsBatch> {
  if (SHARDS.length === 0) {
    return createNativeCsvColumnStatsBatch({
      column: STATS_COLUMN,
      counts: [],
      dictionaryData: new Uint8Array(0),
      dictionaryOffsets: [0n],
      ids: [],
    });
  }

  const messages = await runWorkers<ColumnStatsWorkerDoneMessage>({
    createMessage(shard, workerIndex) {
      return {
        chunkSize: CHUNK_SIZE,
        column: STATS_COLUMN,
        delimiter: DELIMITER,
        fixedColumns: FIXED_COLUMNS,
        kind: 'columnStats',
        path: FILE,
        shard,
        workerIndex,
      };
    },
  });

  const shardBatches = messages.map((message) => createNativeCsvColumnStatsBatch(message.batch));
  try {
    return mergeColumnStatsBatches(STATS_COLUMN, shardBatches);
  } finally {
    for (const batch of shardBatches) {
      batch.close();
    }
  }
}

async function runWorkers<TMessage extends GroupByCountWorkerDoneMessage | ColumnStatsWorkerDoneMessage>(options: {
  createMessage: (shard: TrustedShard, workerIndex: number) => WorkerRunMessage;
}): Promise<TMessage[]> {
  const workers = SHARDS.map(() =>
    new Worker(new URL('./aggregate.worker.ts', import.meta.url).href, {
      preload: [],
      type: 'module',
    })
  );

  try {
    return await new Promise<TMessage[]>((resolve, reject) => {
      const results: TMessage[] = [];
      results.length = workers.length;
      let doneWorkers = 0;
      let settled = false;

      const finish = (value: TMessage[]) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const worker of workers) {
          worker.terminate();
        }
        resolve(value);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        for (const worker of workers) {
          worker.terminate();
        }
        reject(error);
      };

      workers.forEach((worker, workerIndex) => {
        worker.onmessage = (event: MessageEvent<TMessage | WorkerErrorMessage>) => {
          const message = event.data;
          if (message.type === 'error') {
            fail(new Error(`worker ${message.workerIndex}: ${message.error}`));
            return;
          }

          results[message.workerIndex] = message;
          ++doneWorkers;
          if (doneWorkers === workers.length) {
            finish(results);
          }
        };
        worker.onerror = (event) => {
          fail(event.error ?? new Error(`worker ${workerIndex} failed`));
        };
        const shard = SHARDS[workerIndex];
        if (shard === undefined) {
          fail(new Error(`missing shard ${String(workerIndex)}`));
          return;
        }
        worker.postMessage(options.createMessage(shard, workerIndex));
      });
    });
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
  }
}

function summarizeGroupByBatch(batch: NativeCsvGroupByCountBatch): GroupByBenchResult {
  const entries = batch.entries().map((entry) => [entry.value, entry.count] as const);
  return summarizeEntries(batch.rowCount, entries);
}

function summarizeColumnStatsBatch(batch: NativeCsvColumnStatsBatch): ColumnStatsBenchResult {
  const entries = batch.entries().map((entry) => [entry.value, entry.count] as const);
  const summary = summarizeEntries(batch.rowCount, entries);
  return {
    ...summary,
    column: batch.column ?? STATS_COLUMN,
  };
}

function summarizeEntries(
  rowCount: number,
  entries: Array<readonly [value: string, count: number]>,
): GroupByBenchResult {
  const sortedByValue = entries.slice().sort(compareEntryValue);
  let hash = FNV_OFFSET;
  let totalCount = 0;
  for (const [value, count,] of sortedByValue) {
    totalCount += count;
    hash = hashValue(hash, value);
    hash = hashValue(hash, '\u0000');
    hash = hashValue(hash, String(count));
    hash = hashValue(hash, '\n');
  }

  return {
    checksum: hashHex(hash),
    dictionaryCount: sortedByValue.length,
    rowCount,
    top: sortedByValue.slice().sort(compareTopEntries).slice(0, 5),
    totalCount,
  };
}

function mergeGroupByCountBatches(batches: readonly NativeCsvGroupByCountBatch[]): NativeCsvGroupByCountBatch {
  let rowCount = 0n;
  const mergedCounts = new Map<string, bigint>();

  for (const batch of batches) {
    rowCount += BigInt(batch.rowCount);
    const counts = batch.counts();
    const offsets = batch.dictionaryOffsets();
    const data = batch.dictionaryData();
    for (let index = 0; index < batch.dictionaryCount; ++index) {
      const start = offsetAt(offsets, index, data.byteLength);
      const end = offsetAt(offsets, index + 1, data.byteLength);
      const value = data.toString('utf8', start, end);
      mergedCounts.set(value, (mergedCounts.get(value) ?? 0n) + (counts[index] ?? 0n));
    }
  }

  const {
    counts,
    dictionaryData,
    dictionaryOffsets,
  } = encodeDictionaryCounts(mergedCounts);

  return createNativeCsvGroupByCountBatch({
    counts,
    dictionaryData,
    dictionaryOffsets,
    rowCount,
  });
}

function mergeColumnStatsBatches(column: number, batches: readonly NativeCsvColumnStatsBatch[]): NativeCsvColumnStatsBatch {
  const dictionaryIndexes = new Map<string, number>();
  const dictionaryValues: string[] = [];
  const counts: bigint[] = [];
  let totalRows = 0;

  for (const batch of batches) {
    totalRows += batch.rowCount;
  }
  if (totalRows > 0xffff_ffff) {
    throw new RangeError(`columnStats merged rowCount exceeds Uint32Array capacity: ${totalRows}`);
  }

  const ids = new Uint32Array(totalRows);
  let rowOffset = 0;

  for (const batch of batches) {
    const localCounts = batch.counts();
    const localOffsets = batch.dictionaryOffsets();
    const localData = batch.dictionaryData();
    const localToGlobal = new Uint32Array(batch.dictionaryCount);

    for (let index = 0; index < batch.dictionaryCount; ++index) {
      const start = offsetAt(localOffsets, index, localData.byteLength);
      const end = offsetAt(localOffsets, index + 1, localData.byteLength);
      const value = localData.toString('utf8', start, end);
      let globalIndex = dictionaryIndexes.get(value);
      if (globalIndex === undefined) {
        globalIndex = dictionaryValues.length;
        dictionaryIndexes.set(value, globalIndex);
        dictionaryValues.push(value);
        counts[globalIndex] = 0n;
      }
      counts[globalIndex] = (counts[globalIndex] ?? 0n) + (localCounts[index] ?? 0n);
      localToGlobal[index] = globalIndex;
    }

    for (const localId of batch.ids()) {
      ids[rowOffset++] = localToGlobal[localId] ?? 0;
    }
  }

  const {
    dictionaryData,
    dictionaryOffsets,
  } = encodeDictionaryValues(dictionaryValues);

  return createNativeCsvColumnStatsBatch({
    column,
    counts: BigUint64Array.from(counts),
    dictionaryData,
    dictionaryOffsets,
    ids,
  });
}

function encodeDictionaryCounts(values: ReadonlyMap<string, bigint>): {
  counts: BigUint64Array;
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array;
} {
  const entries = Array.from(values.entries()).sort(compareStringTuple);
  const counts = new BigUint64Array(entries.length);
  const dictionaryValues: string[] = [];
  dictionaryValues.length = entries.length;
  for (const [index, [value, count,],] of entries.entries()) {
    dictionaryValues[index] = value;
    counts[index] = count;
  }
  const encoded = encodeDictionaryValues(dictionaryValues);
  return {
    counts,
    dictionaryData: encoded.dictionaryData,
    dictionaryOffsets: encoded.dictionaryOffsets,
  };
}

function encodeDictionaryValues(values: readonly string[]): {
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array;
} {
  const encoded = values.map((value) => Buffer.from(value, 'utf8'));
  const dictionaryOffsets = new BigUint64Array(values.length + 1);
  let totalBytes = 0;
  for (const [index, value,] of encoded.entries()) {
    dictionaryOffsets[index] = BigInt(totalBytes);
    totalBytes += value.byteLength;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new RangeError(`dictionary data length exceeds Number.MAX_SAFE_INTEGER: ${totalBytes}`);
    }
  }
  dictionaryOffsets[values.length] = BigInt(totalBytes);

  const dictionaryData = new Uint8Array(totalBytes);
  let offset = 0;
  for (const value of encoded) {
    dictionaryData.set(value, offset);
    offset += value.byteLength;
  }

  return {
    dictionaryData,
    dictionaryOffsets,
  };
}

function offsetAt(offsets: BigUint64Array, index: number, upperBound: number): number {
  const value = offsets[index];
  if (value === undefined) {
    throw new RangeError(`dictionary offset index out of range: ${index}`);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`dictionary offset exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  const offset = Number(value);
  if (offset > upperBound) {
    throw new RangeError(`dictionary offset exceeds backing storage: ${value}`);
  }
  return offset;
}

function projectGroupByResult(result: GroupByBenchResult): Record<string, unknown> {
  return {
    checksum: result.checksum,
    dictionaryCount: result.dictionaryCount,
    rowCount: result.rowCount,
    top: result.top,
    totalCount: result.totalCount,
  };
}

function projectColumnStatsResult(result: ColumnStatsBenchResult): Record<string, unknown> {
  return {
    checksum: result.checksum,
    column: result.column,
    dictionaryCount: result.dictionaryCount,
    rowCount: result.rowCount,
    top: result.top,
    totalCount: result.totalCount,
  };
}

function logGroupByValidation(serial: GroupByBenchResult, workers: GroupByBenchResult): void {
  const equal = serial.rowCount === workers.rowCount
    && serial.totalCount === workers.totalCount
    && serial.dictionaryCount === workers.dictionaryCount
    && serial.checksum === workers.checksum;

  console.log(JSON.stringify({
    equal,
    kind: 'groupByCount',
    serial: projectGroupByResult(serial),
    workers: projectGroupByResult(workers),
  }));

  if (!equal) {
    throw new Error('groupByCount serial/workers mismatch');
  }
}

function logColumnStatsValidation(serial: ColumnStatsBenchResult, workers: ColumnStatsBenchResult): void {
  const equal = serial.column === workers.column
    && serial.rowCount === workers.rowCount
    && serial.totalCount === workers.totalCount
    && serial.dictionaryCount === workers.dictionaryCount
    && serial.checksum === workers.checksum;

  console.log(JSON.stringify({
    equal,
    kind: 'columnStats',
    serial: projectColumnStatsResult(serial),
    workers: projectColumnStatsResult(workers),
  }));

  if (!equal) {
    throw new Error('columnStats serial/workers mismatch');
  }
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

function compareEntryValue(
  left: readonly [value: string, count: number],
  right: readonly [value: string, count: number],
): number {
  if (left[0] < right[0]) {
    return -1;
  }
  if (left[0] > right[0]) {
    return 1;
  }
  return 0;
}

function compareTopEntries(
  left: readonly [value: string, count: number],
  right: readonly [value: string, count: number],
): number {
  if (right[1] !== left[1]) {
    return right[1] - left[1];
  }
  return compareEntryValue(left, right);
}

function compareStringTuple(left: [string, bigint], right: [string, bigint]): number {
  if (left[0] < right[0]) {
    return -1;
  }
  if (left[0] > right[0]) {
    return 1;
  }
  return 0;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffff_ffff_ffff_ffffn;

function hashValue(hash: bigint, value: string): bigint {
  const bytes = Buffer.from(value, 'utf8');
  let next = hash;
  for (const byte of bytes) {
    next ^= BigInt(byte);
    next = (next * FNV_PRIME) & FNV_MASK;
  }
  return next;
}

function hashHex(hash: bigint): string {
  return hash.toString(16).padStart(16, '0');
}
