import type {
  NativeCsvColumnStatsBatch,
  NativeCsvGroupByCountBatch,
} from './batches.ts';
import { findCsvSafeShards } from './files.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import {
  normalizeColumns,
  normalizeFilterColumn,
} from './normalize.ts';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvFieldValue,
  CsvProjectedRow,
  CsvShard,
  CsvStringCacheOptions,
  CsvWhereFilter,
} from './types.ts';
import {
  runColumnStatsWithWorkers,
  runGroupByCountWithWorkers,
  runMultiColumnStatsWithWorkers,
} from './worker-aggregates.ts';

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
  encoding?: CsvApiFileOptions['encoding'];
  path: string;
  shard: CsvShard;
  shardIndex: number;
  where?: WorkerCountFilterMessage;
}

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvApiFileOptions['encoding'];
  path: string;
  selectedColumns?: CsvColumns;
  stringCache?: CsvStringCacheOptions;
  shard: CsvShard;
  shardIndex: number;
  whereEquals?: WorkerEqualsFilterMessage;
}

interface WorkerRowsBatchMessage {
  rows: string[][];
  shardIndex: number;
  type: 'rows';
}

interface WorkerDoneMessage {
  rows?: number;
  shardIndex: number;
  type: 'done';
}

interface WorkerErrorMessage {
  error: string;
  shardIndex: number;
  type: 'error';
}

type CsvSelectedColumnsFromOptions<TOptions extends CsvApiFileOptions> = TOptions extends { columns: infer TColumns extends CsvColumns; }
  ? TColumns
  : TOptions extends { selectedColumns: infer TColumns extends CsvColumns; } ? TColumns
  : undefined;

export class CsvWorkerPool<TColumns extends CsvColumns | undefined = undefined> {
  readonly #path: string;
  readonly #options: CsvApiFileOptions;
  #aggregateWorkers: Worker[] | undefined;
  #countWorkers: Worker[] | undefined;
  #rowsWorkers: Worker[] | undefined;
  #shards: CsvShard[] | undefined;
  #closed = false;
  #busy = false;

  constructor(path: string, options: CsvApiFileOptions) {
    const workerCount = options.workerCount ?? 1;
    if (!Number.isInteger(workerCount) || workerCount <= 1) {
      throw new RangeError(`worker pool requires workerCount > 1: ${workerCount}`);
    }
    this.#path = path;
    this.#options = { ...options };
  }

  get closed(): boolean {
    return this.#closed;
  }

  async count(): Promise<number> {
    this.#assertOpen();
    if (this.#options.strict === true) {
      throw new Error('parallel count does not support strict CSV validation');
    }

    this.#busy = true;
    try {
      const where = normalizeCountWhere(this.#options.where);
      const shards = this.#ensureShards();
      if (shards.length === 0) {
        return 0;
      }
      const workers = this.#ensureCountWorkers(shards.length);
      return await new Promise<number>((resolve, reject) => {
        let settled = false;
        let doneWorkers = 0;
        let total = 0;

        const finish = (value: number) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };

        const fail = (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
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
            total += message.rows ?? 0;
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
              chunkSize: this.#options.chunkSize ?? DEFAULT_CHUNK_SIZE,
              delimiter: this.#options.delimiter,
              encoding: this.#options.encoding,
              path: this.#path,
              shard,
              shardIndex,
              where,
            } satisfies WorkerCountMessage,
          );
        });
      });
    } finally {
      this.#busy = false;
    }
  }

  async *rows(): AsyncGenerator<CsvProjectedRow<TColumns>[], void> {
    this.#assertOpen();
    rejectWorkerRowsUnsupported(this.#options);

    this.#busy = true;
    try {
      const shards = this.#ensureShards();
      if (shards.length === 0) {
        return;
      }
      const workers = this.#ensureRowsWorkers(shards.length);
      const selected = selectedColumns(this.#options);

      type QueueItem =
        | { done: true; }
        | { error: Error; }
        | { rows: CsvProjectedRow<TColumns>[]; };

      const queue: QueueItem[] = [];
      let pendingResolve: (() => void) | undefined;

      const push = (item: QueueItem) => {
        queue.push(item);
        pendingResolve?.();
        pendingResolve = undefined;
      };

      let doneWorkers = 0;

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
            chunkSize: this.#options.chunkSize ?? DEFAULT_CHUNK_SIZE,
            delimiter: this.#options.delimiter,
            encoding: this.#options.encoding,
            path: this.#path,
            selectedColumns: selected,
            stringCache: this.#options.stringCache,
            shard,
            shardIndex,
            whereEquals: normalizeRowsWhere(this.#options.where),
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
      this.#busy = false;
    }
  }

  async groupByCount(column: number): Promise<NativeCsvGroupByCountBatch> {
    this.#assertOpen();

    this.#busy = true;
    try {
      const shards = this.#ensureShards();
      return await runGroupByCountWithWorkers(this.#path, column, this.#options, {
        shards,
        workers: this.#ensureAggregateWorkers(shards.length),
      });
    } finally {
      this.#busy = false;
    }
  }

  async columnStats(column: number): Promise<NativeCsvColumnStatsBatch> {
    this.#assertOpen();

    this.#busy = true;
    try {
      const shards = this.#ensureShards();
      return await runColumnStatsWithWorkers(this.#path, column, this.#options, {
        shards,
        workers: this.#ensureAggregateWorkers(shards.length),
      });
    } finally {
      this.#busy = false;
    }
  }

  async multiColumnStats(columns: CsvColumns): Promise<NativeCsvColumnStatsBatch[]> {
    this.#assertOpen();
    if (columns.length === 0) {
      return [];
    }

    this.#busy = true;
    try {
      const shards = this.#ensureShards();
      return await runMultiColumnStatsWithWorkers(this.#path, columns, this.#options, {
        shards,
        workers: this.#ensureAggregateWorkers(shards.length),
      });
    } finally {
      this.#busy = false;
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const worker of this.#countWorkers ?? []) {
      worker.terminate();
    }
    for (const worker of this.#rowsWorkers ?? []) {
      worker.terminate();
    }
    for (const worker of this.#aggregateWorkers ?? []) {
      worker.terminate();
    }
    this.#aggregateWorkers = undefined;
    this.#countWorkers = undefined;
    this.#rowsWorkers = undefined;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('worker pool is closed');
    }
    if (this.#busy) {
      throw new Error('worker pool is busy');
    }
  }

  #ensureShards(): CsvShard[] {
    if (this.#shards !== undefined) {
      return this.#shards;
    }
    this.#shards = findCsvSafeShards(
      this.#path,
      this.#options.workerCount ?? 1,
      this.#options.delimiter ?? ',',
    );
    return this.#shards;
  }

  #ensureCountWorkers(count: number): Worker[] {
    if (this.#countWorkers !== undefined) {
      return this.#countWorkers;
    }
    this.#countWorkers = Array.from({ length: count }, () =>
      new Worker(new URL('./workers/count.worker.ts', import.meta.url).href, {
        preload: [],
        type: 'module',
      }));
    return this.#countWorkers;
  }

  #ensureRowsWorkers(count: number): Worker[] {
    if (this.#rowsWorkers !== undefined) {
      return this.#rowsWorkers;
    }
    this.#rowsWorkers = Array.from({ length: count }, () =>
      new Worker(new URL('./workers/rows.worker.ts', import.meta.url).href, {
        preload: [],
        type: 'module',
      }));
    return this.#rowsWorkers;
  }

  #ensureAggregateWorkers(count: number): Worker[] {
    if (this.#aggregateWorkers !== undefined) {
      return this.#aggregateWorkers;
    }
    this.#aggregateWorkers = Array.from(
      { length: count },
      () =>
        new Worker(new URL('./workers/aggregates.worker.ts', import.meta.url).href, {
          preload: [],
          type: 'module',
        }),
    );
    return this.#aggregateWorkers;
  }
}

export function createWorkerPool(path: string): CsvWorkerPool;
export function createWorkerPool<TOptions extends CsvApiFileOptions>(
  path: string,
  options: TOptions,
): CsvWorkerPool<CsvSelectedColumnsFromOptions<TOptions>>;
export function createWorkerPool(path: string, options: CsvApiFileOptions = {}): CsvWorkerPool {
  return new CsvWorkerPool(path, options);
}

function selectedColumns(options: CsvApiFileOptions): CsvColumns | undefined {
  if (options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use columns or selectedColumns, not both');
  }
  const columns = options.columns ?? options.selectedColumns;
  normalizeColumns(columns);
  return columns;
}

function rejectWorkerRowsUnsupported(options: CsvApiFileOptions): void {
  if (options.strict === true) {
    throw new Error('parallel rows do not support strict CSV validation');
  }
  if (options.where === undefined || 'equals' in options.where) {
    return;
  }
  throw new Error('parallel rows support only where.equals; use count() for where.in or where.startsWith');
}

function normalizeRowsWhere(where: CsvWhereFilter | undefined): WorkerEqualsFilterMessage | undefined {
  if (where === undefined || !('equals' in where)) {
    return undefined;
  }
  return {
    column: normalizeFilterColumn(where.column),
    value: normalizeFieldValue(where.equals),
  };
}

function normalizeCountWhere(where: CsvWhereFilter | undefined): WorkerCountFilterMessage | undefined {
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
