import {
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
} from './file-stream.ts';
import { findCsvSafeShards } from './files.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import {
  MAX_FILTER_COUNT,
  normalizeColumns,
  normalizeFilterColumn,
  validateRegex,
} from './normalize.ts';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvEncoding,
  CsvFieldValue,
  CsvParallelRowsOptions,
  CsvProjectedRow,
  CsvRegex,
  CsvWhereFilter,
  CsvWherePredicate,
} from './types.ts';

interface WorkerEqualsFilterMessage {
  column: number;
  value: Uint8Array;
}

interface WorkerInFilterMessage {
  column: number;
  values: Uint8Array[];
}

interface WorkerNotNequalsFilterMessage {
  column: number;
  notNequals: Uint8Array;
}

interface WorkerNotInFilterMessage {
  column: number;
  notIn: Uint8Array[];
}

interface WorkerStartsWithFilterMessage {
  column: number;
  prefix: Uint8Array;
}

interface WorkerRegexFilterMessage {
  column: number;
  regex: CsvRegex;
}

type WorkerFilterMessage =
  | WorkerEqualsFilterMessage
  | WorkerInFilterMessage
  | WorkerNotInFilterMessage
  | WorkerNotNequalsFilterMessage
  | WorkerRegexFilterMessage
  | WorkerStartsWithFilterMessage;

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  path: string;
  selectedColumns?: CsvColumns;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  filters?: WorkerFilterMessage[];
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
  rejectCompressedSharding(options, 'parallel row parsing');
  rejectAutoDelimiterSharding(options, 'parallel row parsing');
  rejectWorkerRowsUnsupported(options);

  const selected = selectedColumns(options);
  const filters = normalizeWhere(options.where);
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
          shard,
          shardIndex,
          filters,
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
  const columns = options.columns ?? options.selectedColumns;
  normalizeColumns(columns);
  return columns;
}

function rejectWorkerRowsUnsupported(options: CsvApiFileOptions): void {
  if (options.strict === true) {
    throw new Error('parallel rows do not support strict CSV validation');
  }
}

function normalizeWhere(where: CsvWhereFilter | undefined): WorkerFilterMessage[] | undefined {
  if (where === undefined) {
    return undefined;
  }
  const predicates = 'all' in where ? where.all : [where];
  if (predicates.length === 0) {
    throw new Error('where.all must contain at least one filter');
  }
  if (predicates.length > MAX_FILTER_COUNT) {
    throw new RangeError(`filter count out of range: ${predicates.length}`);
  }
  return predicates.map(normalizePredicate);
}

function normalizePredicate(predicate: CsvWherePredicate): WorkerFilterMessage {
  if ('equals' in predicate) {
    return {
      column: normalizeFilterColumn(predicate.column),
      value: normalizeFieldValue(predicate.equals),
    };
  }
  if ('in' in predicate) {
    if (predicate.in.length === 0) {
      throw new RangeError('filter values must not be empty');
    }
    return {
      column: normalizeFilterColumn(predicate.column),
      values: predicate.in.map((value) => normalizeFieldValue(value)),
    };
  }
  if ('notNequals' in predicate) {
    return {
      column: normalizeFilterColumn(predicate.column),
      notNequals: normalizeFieldValue(predicate.notNequals),
    };
  }
  if ('notIn' in predicate) {
    if (predicate.notIn.length === 0) {
      throw new RangeError('filter values must not be empty');
    }
    return {
      column: normalizeFilterColumn(predicate.column),
      notIn: predicate.notIn.map((value) => normalizeFieldValue(value)),
    };
  }
  if ('startsWith' in predicate) {
    return {
      column: normalizeFilterColumn(predicate.column),
      prefix: normalizeFieldValue(predicate.startsWith),
    };
  }
  validateRegex(predicate.regex);
  return {
    column: normalizeFilterColumn(predicate.column),
    regex: predicate.regex,
  };
}

function normalizeFieldValue(value: CsvFieldValue): Uint8Array {
  if (typeof value === 'string') {
    return Buffer.from(value);
  }
  return value;
}
