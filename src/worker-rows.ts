import { findCsvSafeShards } from './files.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvEncoding,
  CsvFieldValue,
  CsvParallelRowsOptions,
  CsvProjectedRow,
  CsvStringCacheOptions,
  CsvWhereFilter,
} from './types.ts';

interface WorkerEqualsFilterMessage {
  column: number;
  value: Uint8Array;
}

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  path: string;
  selectedColumns?: CsvColumns;
  stringCache?: CsvStringCacheOptions;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  whereEquals?: WorkerEqualsFilterMessage;
}

interface WorkerRowsBatchMessage {
  rows: string[][];
  shardIndex: number;
  type: 'rows';
}

interface WorkerDoneMessage {
  shardIndex: number;
  type: 'done';
}

interface WorkerErrorMessage {
  error: string;
  shardIndex: number;
  type: 'error';
}

/**
 * Stream materialized rows through Bun workers.
 *
 * Use this when the main cost is parsing/materialization and you want explicit
 * worker fan-out. `workerCount` is required here by design.
 */
export async function* parallelRows<TColumns extends CsvColumns | undefined = undefined>(
  path: string,
  options: CsvParallelRowsOptions<TColumns>,
): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
  const workerCount = options.workerCount ?? 1;
  if (!Number.isInteger(workerCount) || workerCount <= 1) {
    throw new RangeError(`parallel rows require workerCount > 1: ${workerCount}`);
  }
  rejectWorkerRowsUnsupported(options);

  const selected = selectedColumns(options);
  const shards = findCsvSafeShards(path, workerCount, options.delimiter ?? ',');
  if (shards.length === 0) {
    return;
  }

  const workers = shards.map(() =>
    new Worker(new URL('./workers/rows.worker.ts', import.meta.url).href, {
      preload: [],
      type: 'module',
    })
  );

  type QueueItem<T extends CsvColumns | undefined> =
    | { done: true; }
    | { error: Error; }
    | { rows: CsvProjectedRow<T>[]; };

  const queue: QueueItem<TColumns>[] = [];
  let pendingResolve: (() => void) | undefined;

  const push = (item: QueueItem<TColumns>) => {
    queue.push(item);
    pendingResolve?.();
    pendingResolve = undefined;
  };

  let doneWorkers = 0;

  try {
    workers.forEach((worker, shardIndex) => {
      const shard = shards[shardIndex];
      if (shard === undefined) {
        push({ error: new Error(`missing shard ${String(shardIndex)}`) });
        return;
      }
      worker.onmessage = (event: MessageEvent<WorkerRowsBatchMessage | WorkerDoneMessage | WorkerErrorMessage>) => {
        const message = event.data;
        if (message.type === 'rows') {
          push({
            rows: message.rows as CsvProjectedRow<TColumns>[],
          });
          return;
        }
        if (message.type === 'error') {
          push({
            error: new Error(`worker ${message.shardIndex}: ${message.error}`),
          });
          return;
        }

        ++doneWorkers;
        if (doneWorkers === workers.length) {
          push({ done: true });
        }
      };
      worker.onerror = (event) => {
        push({
          error: event.error instanceof Error ? event.error : new Error(`worker ${shardIndex} failed`),
        });
      };

      worker.postMessage(
        {
          chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
          delimiter: options.delimiter,
          encoding: options.encoding,
          path,
          selectedColumns: selected,
          stringCache: options.stringCache,
          shard,
          shardIndex,
          whereEquals: whereEqualsFilter(options.where),
        } satisfies WorkerRowsMessage,
      );
    });

    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          pendingResolve = resolve;
        });
      }

      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) {
          continue;
        }
        if ('error' in item) {
          throw item.error;
        }
        if ('done' in item) {
          return;
        }
        if (item.rows.length > 0) {
          yield item.rows;
        }
      }
    }
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
  }
}

function selectedColumns(options: CsvApiFileOptions): CsvColumns | undefined {
  if (options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use columns or selectedColumns, not both');
  }
  return options.columns ?? options.selectedColumns;
}

function rejectWorkerRowsUnsupported(options: CsvApiFileOptions): void {
  if (options.strict === true) {
    throw new Error('parallel rows do not support strict CSV validation');
  }
  ensureRowsWhereSupported(options.where);
}

function ensureRowsWhereSupported(where: CsvWhereFilter | undefined): void {
  if (where === undefined || 'equals' in where) {
    return;
  }
  throw new Error(
    'parallel rows support only where.equals; use count() for where.in or where.startsWith, or pre-filter inside the worker consumer',
  );
}

function whereEqualsFilter(where: CsvWhereFilter | undefined): WorkerEqualsFilterMessage | undefined {
  if (where === undefined || !('equals' in where)) {
    return undefined;
  }
  return {
    column: where.column,
    value: normalizeFieldValue(where.equals),
  };
}

function normalizeFieldValue(value: CsvFieldValue): Uint8Array {
  if (typeof value === 'string') {
    return Buffer.from(value);
  }
  return value;
}
