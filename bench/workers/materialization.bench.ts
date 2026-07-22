import { measure } from 'mitata';
import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../../src/index.ts';
import type { CsvColumns } from '../../src/types.ts';
import { matchesBenchmarkName } from '../benchmark-filter.ts';
import {
  buildCsvSafeShards,
  buildNativeCsvSafeShards,
  buildNewlineAlignedShards,
  fileSize,
  type TrustedShard,
} from './common.ts';

type MaterializeMode = 'message-final' | 'shared-progress';

interface WorkerDoneMessage {
  type: 'done';
  rows: number;
  workerIndex: number;
}

interface WorkerErrorMessage {
  error: string;
  type: 'error';
  workerIndex: number;
}

const GENERATED_ROWS = Number(Bun.env['CSV_BENCH_GENERATED_ROWS'] ?? 5_000_000);
const FILE = Bun.env['CSV_BENCH_FILE'] ?? await ensureMaterializeFixture(GENERATED_ROWS);
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const WORKERS = Number(Bun.env['CSV_BENCH_WORKERS'] ?? 4);
const SPLITTER = Bun.env['CSV_BENCH_WORKER_SPLITTER'] ?? 'native-csv-safe';
const SELECTED_COLUMNS = parseColumns(Bun.env['CSV_BENCH_COLUMNS'] ?? '0,4,19');
const bytes = fileSize(FILE);
const shardStartedAt = performance.now();
const shards = await loadShards();
const shardSeconds = (performance.now() - shardStartedAt) / 1000;

console.log({
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  file: FILE,
  requestedWorkers: WORKERS,
  selectedColumns: SELECTED_COLUMNS,
  shardBuildSeconds: shardSeconds,
  shardCount: shards.length,
  splitter: SPLITTER,
});

const cases = [
  ['single-thread rowsInto selected', () => materializeSingleThread(false)],
  ['single-thread projected rowsInto', () => materializeSingleThread(true)],
  ['workers projected final', () => materializeWorkers('message-final', true, shards)],
  ['workers projected shared', () => materializeWorkers('shared-progress', true, shards)],
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

async function materializeSingleThread(projection: boolean): Promise<number> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = projection
        ? parser.writeProjectedBatch(chunk as Buffer, { selectedColumns: SELECTED_COLUMNS })
        : parser.writeBatch(chunk as Buffer);
      try {
        rows += projection
          ? batch.rowsInto(rowsBuffer).length
          : batch.rowsInto(rowsBuffer, SELECTED_COLUMNS).length;
      } finally {
        batch.close();
      }
    }
    const batch = projection
      ? parser.endProjectedBatch({ selectedColumns: SELECTED_COLUMNS })
      : parser.endBatch();
    try {
      rows += projection
        ? batch.rowsInto(rowsBuffer).length
        : batch.rowsInto(rowsBuffer, SELECTED_COLUMNS).length;
    } finally {
      batch.close();
    }
    return rows;
  } finally {
    parser.close();
  }
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

async function materializeWorkers(
  mode: MaterializeMode,
  projection: boolean,
  trustedShards: TrustedShard[],
): Promise<number> {
  if (trustedShards.length === 0) {
    return 0;
  }

  const sharedCounts = mode === 'shared-progress'
    ? new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * trustedShards.length)
    : undefined;

  const workers = trustedShards.map(() =>
    new Worker(new URL('./materialize.worker.ts', import.meta.url).href, {
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
        worker.onmessage = (event: MessageEvent<WorkerDoneMessage | WorkerErrorMessage>) => {
          const message = event.data;
          if (message.type === 'error') {
            fail(new Error(`worker ${message.workerIndex}: ${message.error}`));
            return;
          }

          ++doneWorkers;
          if (mode === 'message-final') {
            rows += message.rows;
          } else {
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
          mode,
          path: FILE,
          projection,
          selectedColumns: SELECTED_COLUMNS,
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

function parseColumns(value: string): CsvColumns {
  return value
    .split(',')
    .filter((item) => item.trim() !== '')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

async function ensureMaterializeFixture(rows: number): Promise<string> {
  const path = `/tmp/csv-workers-materialize-${rows}.csv`;
  const file = Bun.file(path);
  if (await file.exists()) {
    return path;
  }

  const writer = file.writer();
  for (let index = 0; index < rows; ++index) {
    await writer.write(
      `${index};0001;0${index % 99};1;;02;20251111;00;;;20251111;1412602;1340501,5813100;RUA;NOME ${index};18;`
        + `"ANDAR ${index % 20};APT ${index % 500};BLOCO ${index % 40}";BAIRRO ${index % 1000};74370455;SP;9373;66;99148283;;;;;`
        + `email${index}@example.com;;\n`,
    );
  }
  await writer.end();
  return path;
}
