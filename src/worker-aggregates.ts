import {
  createNativeCsvColumnStatsBatch,
  createNativeCsvGroupByCountBatch,
  type NativeCsvColumnStatsBatch,
  type NativeCsvGroupByCountBatch,
} from './batches.ts';
import { findCsvSafeShards } from './files.ts';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import type {
  CsvApiFileOptions,
  CsvColumns,
  CsvEncoding,
  CsvShard,
} from './types.ts';

interface WorkerAggregateBaseMessage {
  chunkSize?: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  path: string;
  shard: CsvShard;
  shardIndex: number;
}

interface WorkerGroupByCountMessage extends WorkerAggregateBaseMessage {
  column: number;
  type: 'groupByCount';
}

interface WorkerColumnStatsMessage extends WorkerAggregateBaseMessage {
  column: number;
  type: 'columnStats';
}

interface WorkerMultiColumnStatsMessage extends WorkerAggregateBaseMessage {
  columns: CsvColumns;
  type: 'multiColumnStats';
}

type WorkerAggregateMessage =
  | WorkerGroupByCountMessage
  | WorkerColumnStatsMessage
  | WorkerMultiColumnStatsMessage;

interface WorkerGroupByCountPayload {
  counts: BigUint64Array;
  dictionaryData: Uint8Array;
  dictionaryOffsets: Uint32Array;
  rowCount: number;
}

interface WorkerColumnStatsPayload extends WorkerGroupByCountPayload {
  column?: number;
  ids: Uint32Array;
}

interface WorkerGroupByCountDoneMessage {
  result: WorkerGroupByCountPayload;
  shardIndex: number;
  type: 'groupByCountDone';
}

interface WorkerColumnStatsDoneMessage {
  result: WorkerColumnStatsPayload;
  shardIndex: number;
  type: 'columnStatsDone';
}

interface WorkerMultiColumnStatsDoneMessage {
  results: WorkerColumnStatsPayload[];
  shardIndex: number;
  type: 'multiColumnStatsDone';
}

interface WorkerErrorMessage {
  error: string;
  shardIndex: number;
  type: 'error';
}

type WorkerAggregateDoneMessage =
  | WorkerGroupByCountDoneMessage
  | WorkerColumnStatsDoneMessage
  | WorkerMultiColumnStatsDoneMessage;

type WorkerAggregateResponseMessage = WorkerAggregateDoneMessage | WorkerErrorMessage;

interface WorkerExecutionOptions {
  shards?: CsvShard[];
  workers?: Worker[];
}

export async function parallelGroupByCount(
  path: string,
  column: number,
  options: CsvApiFileOptions = {},
): Promise<NativeCsvGroupByCountBatch> {
  const shards = workerShards(path, options);
  if (shards.length === 0) {
    return createNativeCsvGroupByCountBatch({
      counts: new BigUint64Array(0),
      dictionaryData: new Uint8Array(0),
      dictionaryOffsets: new Uint32Array([0]),
      rowCount: 0,
    });
  }
  const workers = createAggregateWorkers(shards.length);
  try {
    return await runGroupByCountWithWorkers(path, column, options, { shards, workers });
  } finally {
    terminateWorkers(workers);
  }
}

export async function parallelColumnStats(
  path: string,
  column: number,
  options: CsvApiFileOptions = {},
): Promise<NativeCsvColumnStatsBatch> {
  const shards = workerShards(path, options);
  if (shards.length === 0) {
    return createNativeCsvColumnStatsBatch({
      column,
      counts: new BigUint64Array(0),
      dictionaryData: new Uint8Array(0),
      dictionaryOffsets: new Uint32Array([0]),
      ids: new Uint32Array(0),
    });
  }
  const workers = createAggregateWorkers(shards.length);
  try {
    return await runColumnStatsWithWorkers(path, column, options, { shards, workers });
  } finally {
    terminateWorkers(workers);
  }
}

export async function parallelMultiColumnStats(
  path: string,
  columns: CsvColumns,
  options: CsvApiFileOptions = {},
): Promise<NativeCsvColumnStatsBatch[]> {
  if (columns.length === 0) {
    return [];
  }
  const shards = workerShards(path, options);
  if (shards.length === 0) {
    return columns.map((column) => createNativeCsvColumnStatsBatch({
      column,
      counts: new BigUint64Array(0),
      dictionaryData: new Uint8Array(0),
      dictionaryOffsets: new Uint32Array([0]),
      ids: new Uint32Array(0),
    }));
  }
  const workers = createAggregateWorkers(shards.length);
  try {
    return await runMultiColumnStatsWithWorkers(path, columns, options, { shards, workers });
  } finally {
    terminateWorkers(workers);
  }
}

export async function runGroupByCountWithWorkers(
  path: string,
  column: number,
  options: CsvApiFileOptions,
  execution: WorkerExecutionOptions,
): Promise<NativeCsvGroupByCountBatch> {
  rejectWorkerAggregatesUnsupported(options, 'groupByCount');
  const results = await runWorkerJob<WorkerGroupByCountDoneMessage>(
    path,
    options,
    execution,
    (shard, shardIndex) => ({
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      column,
      delimiter: options.delimiter,
      encoding: options.encoding,
      path,
      shard,
      shardIndex,
      type: 'groupByCount',
    }),
    'groupByCountDone',
  );
  return mergeGroupByResults(results.map((result) => result.result));
}

export async function runColumnStatsWithWorkers(
  path: string,
  column: number,
  options: CsvApiFileOptions,
  execution: WorkerExecutionOptions,
): Promise<NativeCsvColumnStatsBatch> {
  rejectWorkerAggregatesUnsupported(options, 'columnStats');
  const results = await runWorkerJob<WorkerColumnStatsDoneMessage>(
    path,
    options,
    execution,
    (shard, shardIndex) => ({
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      column,
      delimiter: options.delimiter,
      encoding: options.encoding,
      path,
      shard,
      shardIndex,
      type: 'columnStats',
    }),
    'columnStatsDone',
  );
  return mergeColumnStatsResults(column, results.map((result) => result.result));
}

export async function runMultiColumnStatsWithWorkers(
  path: string,
  columns: CsvColumns,
  options: CsvApiFileOptions,
  execution: WorkerExecutionOptions,
): Promise<NativeCsvColumnStatsBatch[]> {
  rejectWorkerAggregatesUnsupported(options, 'multiColumnStats');
  const results = await runWorkerJob<WorkerMultiColumnStatsDoneMessage>(
    path,
    options,
    execution,
    (shard, shardIndex) => ({
      chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      columns,
      delimiter: options.delimiter,
      encoding: options.encoding,
      path,
      shard,
      shardIndex,
      type: 'multiColumnStats',
    }),
    'multiColumnStatsDone',
  );

  const batches: NativeCsvColumnStatsBatch[] = [];
  batches.length = columns.length;
  for (let columnIndex = 0; columnIndex < columns.length; ++columnIndex) {
    const column = columns[columnIndex]!;
    const shardPayloads = results.map((result) => {
      const payload = result.results[columnIndex];
      if (payload === undefined) {
        throw new Error(`worker ${result.shardIndex}: missing multiColumnStats payload for column ${column}`);
      }
      return payload;
    });
    batches[columnIndex] = mergeColumnStatsResults(column, shardPayloads);
  }
  return batches;
}

function workerShards(path: string, options: CsvApiFileOptions): CsvShard[] {
  const workerCount = options.workerCount ?? 1;
  if (!Number.isInteger(workerCount) || workerCount <= 1) {
    throw new RangeError(`parallel aggregates require workerCount > 1: ${workerCount}`);
  }
  return findCsvSafeShards(path, workerCount, options.delimiter ?? ',');
}

function createAggregateWorkers(count: number): Worker[] {
  return Array.from({ length: count }, () => new Worker(new URL('./workers/aggregates.worker.ts', import.meta.url).href, {
    preload: [],
    type: 'module',
  }));
}

function terminateWorkers(workers: readonly Worker[]): void {
  for (const worker of workers) {
    worker.terminate();
  }
}

async function runWorkerJob<TDone extends WorkerAggregateDoneMessage>(
  path: string,
  options: CsvApiFileOptions,
  execution: WorkerExecutionOptions,
  makeMessage: (shard: CsvShard, shardIndex: number) => WorkerAggregateMessage,
  expectedType: TDone['type'],
): Promise<TDone[]> {
  const shards = execution.shards ?? workerShards(path, options);
  const workers = execution.workers ?? createAggregateWorkers(shards.length);
  const ownWorkers = execution.workers === undefined;
  if (workers.length === 0) {
    return [];
  }

  try {
    return await new Promise<TDone[]>((resolve, reject) => {
      let settled = false;
      let doneWorkers = 0;
      const results: TDone[] = [];
      results.length = workers.length;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(results);
      };

      const fail = (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      workers.forEach((worker, shardIndex) => {
        worker.onmessage = (event: MessageEvent<WorkerAggregateResponseMessage>) => {
          const message = event.data;
          if (message.type === 'error') {
            fail(new Error(`worker ${message.shardIndex}: ${message.error}`));
            return;
          }
          if (message.type !== expectedType) {
            fail(new Error(`worker ${message.shardIndex}: unexpected aggregate response ${message.type}`));
            return;
          }
          results[shardIndex] = message as TDone;
          ++doneWorkers;
          if (doneWorkers === workers.length) {
            finish();
          }
        };
        worker.onerror = (event) => {
          fail(event.error instanceof Error ? event.error : new Error(`worker ${shardIndex} failed`));
        };
        worker.postMessage(makeMessage(shards[shardIndex]!, shardIndex));
      });
    });
  } finally {
    if (ownWorkers) {
      terminateWorkers(workers);
    }
  }
}

function mergeGroupByResults(results: readonly WorkerGroupByCountPayload[]): NativeCsvGroupByCountBatch {
  let rowCount = 0;
  const dictionary = new Map<string, bigint>();

  for (const result of results) {
    rowCount += result.rowCount;
    const values = decodeDictionary(result.dictionaryData, result.dictionaryOffsets);
    for (let index = 0; index < values.length; ++index) {
      const value = values[index] ?? '';
      const count = result.counts[index] ?? 0n;
      dictionary.set(value, (dictionary.get(value) ?? 0n) + count);
    }
  }

  const encoded = encodeDictionary([...dictionary.keys()]);
  return createNativeCsvGroupByCountBatch({
    counts: toBigUint64Array([...dictionary.values()]),
    dictionaryData: encoded.data,
    dictionaryOffsets: encoded.offsets,
    rowCount,
  });
}

function mergeColumnStatsResults(column: number, results: readonly WorkerColumnStatsPayload[]): NativeCsvColumnStatsBatch {
  const dictionary = new Map<string, number>();
  const values: string[] = [];
  const counts: bigint[] = [];
  const remappedPerShard: Uint32Array[] = [];
  let totalIds = 0;

  for (const result of results) {
    totalIds += result.ids.length;
    const decoded = decodeDictionary(result.dictionaryData, result.dictionaryOffsets);
    const localToGlobal = new Uint32Array(decoded.length);

    for (let index = 0; index < decoded.length; ++index) {
      const value = decoded[index] ?? '';
      let globalId = dictionary.get(value);
      if (globalId === undefined) {
        globalId = values.length;
        dictionary.set(value, globalId);
        values.push(value);
        counts.push(0n);
      }
      counts[globalId] = (counts[globalId] ?? 0n) + (result.counts[index] ?? 0n);
      localToGlobal[index] = globalId;
    }

    const remapped = new Uint32Array(result.ids.length);
    for (let rowIndex = 0; rowIndex < result.ids.length; ++rowIndex) {
      remapped[rowIndex] = localToGlobal[result.ids[rowIndex] ?? 0] ?? 0;
    }
    remappedPerShard.push(remapped);
  }

  const ids = new Uint32Array(totalIds);
  let offset = 0;
  for (const shardIds of remappedPerShard) {
    ids.set(shardIds, offset);
    offset += shardIds.length;
  }

  const encoded = encodeDictionary(values);
  return createNativeCsvColumnStatsBatch({
    column,
    counts: toBigUint64Array(counts),
    dictionaryData: encoded.data,
    dictionaryOffsets: encoded.offsets,
    ids,
  });
}

function decodeDictionary(data: Uint8Array, offsets: Uint32Array): string[] {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const values: string[] = [];
  values.length = offsets.length === 0 ? 0 : offsets.length - 1;
  for (let index = 0; index < values.length; ++index) {
    const start = offsets[index] ?? 0;
    const end = offsets[index + 1] ?? start;
    values[index] = buffer.toString('utf8', start, end);
  }
  return values;
}

function encodeDictionary(values: readonly string[]): {
  data: Uint8Array;
  offsets: Uint32Array;
} {
  const offsets = new Uint32Array(values.length + 1);
  const chunks: Buffer[] = [];
  let offset = 0;

  for (let index = 0; index < values.length; ++index) {
    offsets[index] = offset;
    const chunk = Buffer.from(values[index] ?? '', 'utf8');
    chunks.push(chunk);
    offset += chunk.byteLength;
  }
  offsets[values.length] = offset;

  const data = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, offset);
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    offsets,
  };
}

function toBigUint64Array(values: readonly bigint[]): BigUint64Array {
  const result = new BigUint64Array(values.length);
  for (let index = 0; index < values.length; ++index) {
    result[index] = values[index] ?? 0n;
  }
  return result;
}

function rejectWorkerAggregatesUnsupported(options: CsvApiFileOptions, name: string): void {
  if (options.strict === true) {
    throw new Error(`parallel ${name} does not support strict CSV validation`);
  }
}
