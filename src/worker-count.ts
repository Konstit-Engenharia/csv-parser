import { findCsvSafeShards } from './files.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import { normalizeFilterColumn } from './normalize.ts';
import type {
  CsvFieldValue,
  CsvParallelCountOptions,
  CsvWhereFilter,
} from './types.ts';

interface WorkerEqualsFilterMessage {
  column: number;
  value: Uint8Array;
}

interface WorkerInFilterMessage {
  column: number;
  values: Uint8Array[];
}

interface WorkerStartsWithFilterMessage {
  column: number;
  prefix: Uint8Array;
}

type WorkerCountFilterMessage =
  | { equals: WorkerEqualsFilterMessage; }
  | { in: WorkerInFilterMessage; }
  | { startsWith: WorkerStartsWithFilterMessage; };

interface WorkerCountMessage {
  chunkSize?: number;
  delimiter?: string;
  encoding?: CsvParallelCountOptions['encoding'];
  path: string;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  where?: WorkerCountFilterMessage;
}

interface WorkerDoneMessage {
  rows: number;
  shardIndex: number;
  type: 'done';
}

interface WorkerErrorMessage {
  error: string;
  shardIndex: number;
  type: 'error';
}

export async function parallelCount(path: string, options: CsvParallelCountOptions): Promise<number> {
  const workerCount = options.workerCount ?? 1;
  if (!Number.isInteger(workerCount) || workerCount <= 1) {
    throw new RangeError(`parallel count require workerCount > 1: ${workerCount}`);
  }
  if ((options as { strict?: boolean; }).strict === true) {
    throw new Error('parallel count does not support strict CSV validation; use count() without workers for strict schema checks');
  }
  const where = normalizeWhere(options.where);

  const shards = findCsvSafeShards(path, workerCount, options.delimiter ?? ',');
  if (shards.length === 0) {
    return 0;
  }

  const workers = shards.map(() =>
    new Worker(new URL('./workers/count.worker.ts', import.meta.url).href, {
      preload: [],
      type: 'module',
    })
  );

  try {
    return await new Promise<number>((resolve, reject) => {
      let settled = false;
      let doneWorkers = 0;
      let total = 0;

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

      workers.forEach((worker, shardIndex) => {
        const shard = shards[shardIndex];
        if (shard === undefined) {
          fail(new Error(`missing shard ${String(shardIndex)}`));
          return;
        }
        worker.onmessage = (event: MessageEvent<WorkerDoneMessage | WorkerErrorMessage>) => {
          const message = event.data;
          if (message.type === 'error') {
            fail(new Error(`worker ${message.shardIndex}: ${message.error}`));
            return;
          }
          total += message.rows;
          if (!Number.isSafeInteger(total)) {
            fail(new RangeError(`parallel row count exceeds Number.MAX_SAFE_INTEGER: ${total}`));
            return;
          }
          ++doneWorkers;
          if (doneWorkers === workers.length) {
            finish(total);
          }
        };
        worker.onerror = (event) => {
          fail(event.error instanceof Error ? event.error : new Error(`worker ${shardIndex} failed`));
        };
        worker.postMessage(
          {
            chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
            delimiter: options.delimiter,
            encoding: options.encoding,
            path,
            shard,
            shardIndex,
            where,
          } satisfies WorkerCountMessage,
        );
      });
    });
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
  }
}

function normalizeWhere(where: CsvWhereFilter | undefined): WorkerCountFilterMessage | undefined {
  if (where === undefined) {
    return undefined;
  }
  if ('equals' in where) {
    return {
      equals: {
        column: normalizeFilterColumn(where.column),
        value: normalizeFieldValue(where.equals),
      },
    };
  }
  if ('in' in where) {
    return {
      in: {
        column: normalizeFilterColumn(where.column),
        values: where.in.map((value) => normalizeFieldValue(value)),
      },
    };
  }
  return {
    startsWith: {
      column: normalizeFilterColumn(where.column),
      prefix: normalizeFieldValue(where.startsWith),
    },
  };
}

function normalizeFieldValue(value: CsvFieldValue): Uint8Array {
  if (typeof value === 'string') {
    return Buffer.from(value);
  }
  return value;
}
