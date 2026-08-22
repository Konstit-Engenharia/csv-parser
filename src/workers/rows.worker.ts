import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../parser.ts';
import type {
  CsvColumns,
  CsvEncoding,
  CsvRegex,
} from '../types.ts';

interface WorkerEqualsFilter {
  column: number;
  value: Uint8Array;
}

interface WorkerInFilter {
  column: number;
  values: Uint8Array[];
}

interface WorkerStartsWithFilter {
  column: number;
  prefix: Uint8Array;
}

interface WorkerRegexFilter {
  column: number;
  regex: CsvRegex;
}

type WorkerFilter = WorkerEqualsFilter | WorkerInFilter | WorkerRegexFilter | WorkerStartsWithFilter;

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  selectedColumns?: CsvColumns;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  path: string;
  filters?: WorkerFilter[];
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

addEventListener('message', async (event: MessageEvent<WorkerRowsMessage>) => {
  const message = event.data;
  try {
    await streamShardRows(message);
    postMessage(
      {
        shardIndex: message.shardIndex,
        type: 'done',
      } satisfies WorkerDoneMessage,
    );
  } catch (error) {
    postMessage(
      {
        error: error instanceof Error ? error.message : String(error),
        shardIndex: message.shardIndex,
        type: 'error',
      } satisfies WorkerErrorMessage,
    );
  }
});

async function streamShardRows(message: WorkerRowsMessage): Promise<void> {
  const parser = new NativeCsvParser({
    delimiter: message.delimiter,
    encoding: message.encoding,
  });
  const rowsBuffer: string[][] = [];
  try {
    for await (
      const chunk of createReadStream(message.path, {
        end: message.shard.end,
        highWaterMark: message.chunkSize,
        start: message.shard.start,
      })
    ) {
      const batch = writeRowsBatch(parser, chunk as Buffer, message);
      try {
        const rows = materializeRows(batch, message, rowsBuffer);
        if (rows.length > 0) {
          postMessage(
            {
              rows,
              shardIndex: message.shardIndex,
              type: 'rows',
            } satisfies WorkerRowsBatchMessage,
          );
        }
      } finally {
        batch.close();
      }
    }

    const batch = finishRowsBatch(parser, message);
    try {
      const rows = materializeRows(batch, message, rowsBuffer);
      if (rows.length > 0) {
        postMessage(
          {
            rows,
            shardIndex: message.shardIndex,
            type: 'rows',
          } satisfies WorkerRowsBatchMessage,
        );
      }
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

function materializeRows(
  batch: ReturnType<NativeCsvParser['writeBatch']>,
  message: WorkerRowsMessage,
  rowsBuffer: string[][],
): string[][] {
  if (usesProjectedMaterialization(message)) {
    return batch.rowsInto(rowsBuffer);
  }
  return batch.rowsInto(rowsBuffer, message.selectedColumns);
}

function writeRowsBatch(parser: NativeCsvParser, chunk: Buffer, message: WorkerRowsMessage) {
  if (message.filters !== undefined) {
    return parser.writeProjectedBatch(chunk, {
      filters: message.filters,
      selectedColumns: message.selectedColumns,
    });
  }
  if (message.selectedColumns !== undefined) {
    return parser.writeProjectedBatch(chunk, {
      selectedColumns: message.selectedColumns,
    });
  }
  return parser.writeBatch(chunk);
}

function finishRowsBatch(parser: NativeCsvParser, message: WorkerRowsMessage) {
  if (message.filters !== undefined) {
    return parser.endProjectedBatch({
      filters: message.filters,
      selectedColumns: message.selectedColumns,
    });
  }
  if (message.selectedColumns !== undefined) {
    return parser.endProjectedBatch({
      selectedColumns: message.selectedColumns,
    });
  }
  return parser.endBatch();
}

function usesProjectedMaterialization(message: WorkerRowsMessage): boolean {
  return message.filters !== undefined || message.selectedColumns !== undefined;
}
