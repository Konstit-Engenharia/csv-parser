import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../parser.ts';
import { CsvStringCache } from '../string-cache.ts';
import type {
  CsvColumns,
  CsvEncoding,
  CsvStringCacheOptions,
} from '../types.ts';

interface WorkerEqualsFilter {
  column: number;
  value: Uint8Array;
}

interface WorkerRowsMessage {
  chunkSize: number;
  delimiter?: string;
  encoding?: CsvEncoding;
  selectedColumns?: CsvColumns;
  stringCache?: CsvStringCacheOptions;
  shard: {
    start: number;
    end: number;
  };
  shardIndex: number;
  path: string;
  whereEquals?: WorkerEqualsFilter;
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
  const stringCache = message.stringCache === undefined ? undefined : new CsvStringCache(message.stringCache);
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
        const rows = materializeRows(batch, message, rowsBuffer, stringCache);
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
      const rows = materializeRows(batch, message, rowsBuffer, stringCache);
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
  stringCache?: CsvStringCache,
): string[][] {
  if (stringCache !== undefined && message.selectedColumns !== undefined && usesProjectedMaterialization(message)) {
    return materializeProjectedRows(batch, rowsBuffer, message.selectedColumns, stringCache);
  }
  if (usesProjectedMaterialization(message)) {
    return batch.rowsInto(rowsBuffer);
  }
  return batch.rowsInto(rowsBuffer, message.selectedColumns, stringCache);
}

function materializeProjectedRows(
  batch: ReturnType<NativeCsvParser['writeBatch']>,
  target: string[][],
  columns: CsvColumns,
  stringCache: CsvStringCache,
): string[][] {
  target.length = batch.rowCount;
  const projectedColumns = projectedColumnIndexes(columns);
  batch.scanColumns(projectedColumns, (rowIndex, ranges, data) => {
    const existing = target[rowIndex];
    const row = existing === undefined ? [] : existing;
    row.length = columns.length;
    for (let columnIndex = 0; columnIndex < columns.length; ++columnIndex) {
      const rangeIndex = columnIndex * 2;
      const start = ranges[rangeIndex] ?? -1;
      const end = ranges[rangeIndex + 1] ?? -1;
      row[columnIndex] = start === -1 || end === -1
        ? ''
        : stringCache.decode(data, start, end, columns[columnIndex] ?? 0);
    }
    target[rowIndex] = row;
  });
  return target;
}

function writeRowsBatch(parser: NativeCsvParser, chunk: Buffer, message: WorkerRowsMessage) {
  if (message.whereEquals !== undefined) {
    return parser.writeProjectedBatch(chunk, {
      equalsFilter: {
        column: message.whereEquals.column,
        value: message.whereEquals.value,
      },
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
  if (message.whereEquals !== undefined) {
    return parser.endProjectedBatch({
      equalsFilter: {
        column: message.whereEquals.column,
        value: message.whereEquals.value,
      },
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
  return message.whereEquals !== undefined || message.selectedColumns !== undefined;
}

function projectedColumnIndexes(columns: CsvColumns): CsvColumns {
  const projected: number[] = [];
  projected.length = columns.length;
  for (let index = 0; index < columns.length; ++index) {
    projected[index] = index;
  }
  return projected;
}
