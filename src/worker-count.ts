import {
  rejectAutoDelimiterSharding,
  rejectCompressedSharding,
} from './file-stream.ts';
import { findCsvSafeShards } from './files.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import {
  MAX_FILTER_COUNT,
  normalizeFilterColumn,
  validateRegex,
} from './normalize.ts';
import type {
  CsvFieldValue,
  CsvParallelCountOptions,
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
  filters?: WorkerFilterMessage[];
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
  rejectCompressedSharding(options, 'parallel counting');
  rejectAutoDelimiterSharding(options, 'parallel counting');
  if ((options as { strict?: boolean; }).strict === true) {
    throw new Error('parallel count does not support strict CSV validation; use count() without workers for strict schema checks');
  }
  const filters = normalizeWhere(options.where);

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
            filters,
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
