import { measure } from 'mitata';
import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../../src/index.ts';
import { matchesBenchmarkName } from '../benchmark-filter.ts';
import {
  buildNativeCsvSafeShards,
  fileSize,
  type TrustedShard,
} from './common.ts';

interface NativeSinkResult {
  cells: number;
  dataBytes: number;
  rows: number;
}

interface WorkerDoneMessage extends NativeSinkResult {
  type: 'done';
  workerIndex: number;
}

interface WorkerErrorMessage {
  error: string;
  type: 'error';
  workerIndex: number;
}

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? Bun.env['CSV_BENCH_WORKERS'] ?? 4);
const bytes = fileSize(FILE);
const shards = buildNativeCsvSafeShards(FILE, WORKERS, DELIMITER);

console.log({
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  file: FILE,
  shardCount: shards.length,
  workers: WORKERS,
});

const cases = [
  ['native single-thread sink all columns', () => sinkSingleThread()],
  ['native workers sink all columns', () => sinkWorkers(shards)],
] as const;

for (const [name, fn,] of cases) {
  if (!matchesBenchmarkName(name)) {
    continue;
  }

  let result: NativeSinkResult = {
    cells: 0,
    dataBytes: 0,
    rows: 0,
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
  console.log({
    cells: result.cells,
    dataBytes: result.dataBytes,
    mibPerSecond: bytes / 1024 / 1024 / seconds,
    name,
    rows: result.rows,
    seconds,
  });
}

async function sinkSingleThread(): Promise<NativeSinkResult> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  let rows = 0;
  let cells = 0;
  let dataBytes = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        rows += batch.rowCount;
        cells += batch.totalFields;
        dataBytes += batch.dataLength;
      } finally {
        batch.close();
      }
    }

    const batch = parser.endBatch();
    try {
      rows += batch.rowCount;
      cells += batch.totalFields;
      dataBytes += batch.dataLength;
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }

  return { cells, dataBytes, rows };
}

async function sinkWorkers(trustedShards: TrustedShard[]): Promise<NativeSinkResult> {
  if (trustedShards.length === 0) {
    return { cells: 0, dataBytes: 0, rows: 0 };
  }

  const workers = trustedShards.map(() =>
    new Worker(new URL('./native-sink.worker.ts', import.meta.url).href, {
      preload: [],
      type: 'module',
    })
  );

  try {
    return await new Promise<NativeSinkResult>((resolve, reject) => {
      let settled = false;
      let doneWorkers = 0;
      let rows = 0;
      let cells = 0;
      let dataBytes = 0;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        for (const worker of workers) {
          worker.terminate();
        }
        resolve({ cells, dataBytes, rows });
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

          rows += message.rows;
          cells += message.cells;
          dataBytes += message.dataBytes;
          ++doneWorkers;
          if (doneWorkers === workers.length) {
            finish();
          }
        };
        worker.onerror = (event) => {
          fail(event.error ?? new Error(`worker ${workerIndex} failed`));
        };
        worker.postMessage({
          chunkSize: CHUNK_SIZE,
          delimiter: DELIMITER,
          path: FILE,
          shard: trustedShards[workerIndex],
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
