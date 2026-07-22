import { measure } from 'mitata';
import { countCsvFile } from '../../src/index.ts';
import { matchesBenchmarkName } from '../benchmark-filter.ts';
import {
  buildCsvSafeShards,
  buildNativeCsvSafeShards,
  buildNewlineAlignedShards,
  fileSize,
  inferFixedColumns,
  type TrustedShard,
} from './common.ts';

type WorkerMode = 'message-final' | 'message-progress' | 'shared-progress';

interface WorkerDoneMessage {
  type: 'done';
  rows: number;
  workerIndex: number;
}

interface WorkerProgressMessage {
  type: 'progress';
  rows: number;
  workerIndex: number;
}

interface WorkerErrorMessage {
  error: string;
  type: 'error';
  workerIndex: number;
}

const GENERATED_ROWS = Number(Bun.env['CSV_BENCH_GENERATED_ROWS'] ?? 20_000_000);
const FILE = Bun.env['CSV_BENCH_FILE'] ?? await ensureTrustedFixture(GENERATED_ROWS);
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const WORKERS = Number(Bun.env['CSV_BENCH_WORKERS'] ?? 4);
const SPLITTER = Bun.env['CSV_BENCH_WORKER_SPLITTER'] ?? 'native-csv-safe';
const FIXED_COLUMNS = Number(
  Bun.env['CSV_BENCH_FIXED_COLUMNS'] ?? (
    Bun.env['CSV_BENCH_FILE'] === undefined
      ? 5
      : await inferFixedColumns(FILE, DELIMITER)
  ),
);
const bytes = fileSize(FILE);
const shardStartedAt = performance.now();
const shards = await loadShards();
const shardSeconds = (performance.now() - shardStartedAt) / 1000;

console.log({
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  file: FILE,
  fixedColumns: FIXED_COLUMNS,
  requestedWorkers: WORKERS,
  shardBuildSeconds: shardSeconds,
  shardCount: shards.length,
  shards,
  splitter: SPLITTER,
});

const cases = [
  ['native fixed-column single-thread', () => countCsvFile(FILE, fixedColumnOptions())],
  ['workers postMessage final', () => countShardedWorkers('message-final', shards)],
  ['workers postMessage progress', () => countShardedWorkers('message-progress', shards)],
  ['workers shared progress', () => countShardedWorkers('shared-progress', shards)],
] as const;

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
  console.log({
    mibPerSecond: bytes / 1024 / 1024 / seconds,
    name,
    rows,
    seconds,
  });
}

function fixedColumnOptions() {
  return {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    fixedColumns: FIXED_COLUMNS,
  };
}

async function loadShards(): Promise<TrustedShard[]> {
  switch (SPLITTER) {
    case 'newline':
      return buildNewlineAlignedShards(FILE, WORKERS);
    case 'csv-safe':
      return buildCsvSafeShards(FILE, WORKERS, DELIMITER);
    case 'native-csv-safe':
      return buildNativeCsvSafeShards(FILE, WORKERS, DELIMITER);
    default:
      throw new Error(`unknown worker splitter: ${SPLITTER}`);
  }
}

async function countShardedWorkers(mode: WorkerMode, trustedShards: TrustedShard[]): Promise<number> {
  if (trustedShards.length === 0) {
    return 0;
  }

  const sharedCounts = mode === 'shared-progress'
    ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * trustedShards.length)
    : undefined;

  const workers = trustedShards.map(() =>
    new Worker(new URL('./count.worker.ts', import.meta.url).href, {
      preload: [],
      type: 'module',
    })
  );

  try {
    return await new Promise<number>((resolve, reject) => {
      let doneWorkers = 0;
      let rows = 0;
      let settled = false;

      const finish = (value: number) => {
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
        worker.onmessage = (event: MessageEvent<WorkerDoneMessage | WorkerProgressMessage | WorkerErrorMessage>) => {
          const message = event.data;
          if (message.type === 'progress') {
            rows += message.rows;
            return;
          }
          if (message.type === 'error') {
            fail(new Error(`worker ${message.workerIndex}: ${message.error}`));
            return;
          }

          ++doneWorkers;
          if (mode === 'message-final') {
            rows += message.rows;
          } else if (mode === 'shared-progress') {
            if (sharedCounts === undefined) {
              fail(new Error(`missing shared counts for mode ${mode}`));
              return;
            }
            rows = sumSharedCounts(sharedCounts, trustedShards.length);
          }

          if (doneWorkers === workers.length) {
            finish(rows);
          }
        };
        worker.onerror = (event) => {
          fail(event.error ?? new Error(`worker ${workerIndex} failed`));
        };
        worker.postMessage({
          chunkSize: CHUNK_SIZE,
          delimiter: DELIMITER,
          fixedColumns: FIXED_COLUMNS,
          mode,
          path: FILE,
          shard: trustedShards[workerIndex],
          sharedCounts,
          workerIndex,
        });
      });
    });
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
  }
}

function sumSharedCounts(buffer: SharedArrayBuffer, count: number): number {
  const values = new Int32Array(buffer, 0, count);
  let sum = 0;
  for (let index = 0; index < count; ++index) {
    sum += Atomics.load(values, index);
  }
  return sum;
}

async function ensureTrustedFixture(rows: number): Promise<string> {
  const path = `/tmp/csv-workers-trusted-${rows}.csv`;
  const file = Bun.file(path);
  if (await file.exists()) {
    return path;
  }

  const writer = file.writer();
  for (let index = 0; index < rows; ++index) {
    await writer.write(`${index};name${index % 100};city${index % 50};state${index % 27};email${index}@example.com\n`);
  }
  await writer.end();
  return path;
}
