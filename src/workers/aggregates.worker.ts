import { createReadStream } from 'node:fs';
import type {
  NativeCsvColumnStatsBatch,
  NativeCsvGroupByCountBatch,
} from '../batches.ts';
import { DEFAULT_CHUNK_SIZE } from '../native.ts';
import { NativeCsvParser } from '../parser.ts';
import type {
  CsvColumns,
  CsvEncoding,
} from '../types.ts';

interface WorkerAggregateBaseMessage {
  chunkSize?: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  path: string;
  shard: {
    end: number;
    start: number;
  };
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
  dictionaryOffsets: BigUint64Array;
  rowCount: number;
}

interface WorkerColumnStatsPayload extends WorkerGroupByCountPayload {
  column?: number;
  ids: Uint32Array;
}

addEventListener('message', async (event: MessageEvent<WorkerAggregateMessage>) => {
  const message = event.data;
  try {
    if (message.type === 'groupByCount') {
      postMessage({
        result: await groupByCountShard(message),
        shardIndex: message.shardIndex,
        type: 'groupByCountDone',
      });
      return;
    }
    if (message.type === 'columnStats') {
      postMessage({
        result: await columnStatsShard(message),
        shardIndex: message.shardIndex,
        type: 'columnStatsDone',
      });
      return;
    }
    postMessage({
      results: await multiColumnStatsShard(message),
      shardIndex: message.shardIndex,
      type: 'multiColumnStatsDone',
    });
  } catch (error) {
    postMessage({
      error: error instanceof Error ? error.message : String(error),
      shardIndex: message.shardIndex,
      type: 'error',
    });
  }
});

async function groupByCountShard(message: WorkerGroupByCountMessage): Promise<WorkerGroupByCountPayload> {
  const parser = new NativeCsvParser({
    delimiter: message.delimiter,
    encoding: message.encoding,
  });
  try {
    for await (const chunk of shardStream(message)) {
      parser.writeGroupByCount(chunk as Buffer, message.column);
    }
    const batch = parser.endGroupByCount(message.column);
    try {
      return takeGroupByPayload(batch);
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

async function columnStatsShard(message: WorkerColumnStatsMessage): Promise<WorkerColumnStatsPayload> {
  const parser = new NativeCsvParser({
    delimiter: message.delimiter,
    encoding: message.encoding,
  });
  try {
    for await (const chunk of shardStream(message)) {
      parser.writeColumnStats(chunk as Buffer, message.column);
    }
    const batch = parser.endColumnStats(message.column);
    try {
      return takeColumnStatsPayload(batch);
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

async function multiColumnStatsShard(message: WorkerMultiColumnStatsMessage): Promise<WorkerColumnStatsPayload[]> {
  const parser = new NativeCsvParser({
    delimiter: message.delimiter,
    encoding: message.encoding,
  });
  try {
    for await (const chunk of shardStream(message)) {
      parser.writeMultiColumnStats(chunk as Buffer, message.columns);
    }
    const batches = parser.endMultiColumnStats(message.columns);
    try {
      return batches.map((batch) => takeColumnStatsPayload(batch));
    } finally {
      for (const batch of batches) {
        batch.close();
      }
    }
  } finally {
    parser.close();
  }
}

function shardStream(message: WorkerAggregateBaseMessage) {
  return createReadStream(message.path, {
    end: message.shard.end,
    highWaterMark: message.chunkSize ?? DEFAULT_CHUNK_SIZE,
    start: message.shard.start,
  });
}

function takeGroupByPayload(batch: NativeCsvGroupByCountBatch): WorkerGroupByCountPayload {
  return {
    counts: batch.counts().slice(),
    dictionaryData: Uint8Array.from(batch.dictionaryData()),
    dictionaryOffsets: batch.dictionaryOffsets().slice(),
    rowCount: batch.rowCount,
  };
}

function takeColumnStatsPayload(batch: NativeCsvColumnStatsBatch): WorkerColumnStatsPayload {
  return {
    column: batch.column,
    counts: batch.counts().slice(),
    dictionaryData: Uint8Array.from(batch.dictionaryDataView()),
    dictionaryOffsets: batch.dictionaryOffsets().slice(),
    ids: batch.ids().slice(),
    rowCount: batch.rowCount,
  };
}
