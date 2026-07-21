import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../../src/index.ts';
import type { TrustedShard } from './common.ts';

interface BaseWorkerRunMessage {
  chunkSize: number;
  delimiter: string;
  fixedColumns: number;
  path: string;
  shard: TrustedShard;
  workerIndex: number;
}

interface GroupByCountWorkerRunMessage extends BaseWorkerRunMessage {
  kind: 'groupByCount';
  column: number;
}

interface ColumnStatsWorkerRunMessage extends BaseWorkerRunMessage {
  kind: 'columnStats';
  column: number;
}

type WorkerRunMessage = GroupByCountWorkerRunMessage | ColumnStatsWorkerRunMessage;

interface GroupByCountBatchParts {
  counts: BigUint64Array;
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array;
  rowCount: number;
}

interface ColumnStatsBatchParts {
  column: number;
  counts: BigUint64Array;
  dictionaryData: Uint8Array;
  dictionaryOffsets: BigUint64Array;
  ids: Uint32Array;
}

interface GroupByCountWorkerDoneMessage {
  type: 'done';
  kind: 'groupByCount';
  workerIndex: number;
  batch: GroupByCountBatchParts;
}

interface ColumnStatsWorkerDoneMessage {
  type: 'done';
  kind: 'columnStats';
  workerIndex: number;
  batch: ColumnStatsBatchParts;
}

interface WorkerErrorMessage {
  type: 'error';
  error: string;
  workerIndex: number;
}

addEventListener('message', async (event: MessageEvent<WorkerRunMessage>) => {
  const message = event.data;
  try {
    switch (message.kind) {
      case 'groupByCount': {
        const done = await runGroupByCount(message);
        postMessage(done);
        return;
      }
      case 'columnStats': {
        const done = await runColumnStats(message);
        postMessage(done);
        return;
      }
    }
  } catch (error) {
    postMessage(
      {
        error: error instanceof Error ? error.message : String(error),
        type: 'error',
        workerIndex: message.workerIndex,
      } satisfies WorkerErrorMessage,
    );
  }
});

async function runGroupByCount(message: GroupByCountWorkerRunMessage): Promise<GroupByCountWorkerDoneMessage> {
  const parser = createTrustedParser(message);
  try {
    for await (const chunk of readShardChunks(message)) {
      parser.writeGroupByCount(chunk as Buffer, message.column);
    }

    const batch = parser.endGroupByCount(message.column);
    try {
      return {
        batch: {
          counts: BigUint64Array.from(batch.counts()),
          dictionaryData: Uint8Array.from(batch.dictionaryData()),
          dictionaryOffsets: batch.dictionaryOffsets().slice(),
          rowCount: batch.rowCount,
        },
        kind: 'groupByCount',
        type: 'done',
        workerIndex: message.workerIndex,
      };
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

async function runColumnStats(message: ColumnStatsWorkerRunMessage): Promise<ColumnStatsWorkerDoneMessage> {
  const parser = createTrustedParser(message);
  try {
    for await (const chunk of readShardChunks(message)) {
      parser.writeColumnStats(chunk as Buffer, message.column);
    }

    const batch = parser.endColumnStats(message.column);
    try {
      return {
        batch: {
          column: message.column,
          counts: BigUint64Array.from(batch.counts()),
          dictionaryData: Uint8Array.from(batch.dictionaryData()),
          dictionaryOffsets: batch.dictionaryOffsets().slice(),
          ids: Uint32Array.from(batch.ids()),
        },
        kind: 'columnStats',
        type: 'done',
        workerIndex: message.workerIndex,
      };
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

function createTrustedParser(message: BaseWorkerRunMessage): NativeCsvParser {
  return new NativeCsvParser({
    delimiter: message.delimiter,
    trusted: {
      fixedColumns: message.fixedColumns,
      noNewlinesInQuotes: true,
    },
  });
}

function readShardChunks(message: BaseWorkerRunMessage) {
  return createReadStream(message.path, {
    end: message.shard.end,
    highWaterMark: message.chunkSize,
    start: message.shard.start,
  });
}
