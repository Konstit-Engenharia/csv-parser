import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../../src/index.ts';
import type { TrustedShard } from './common.ts';

interface NativeSinkWorkerRunMessage {
  chunkSize: number;
  delimiter: string;
  path: string;
  shard: TrustedShard;
  workerIndex: number;
}

interface NativeSinkResult {
  cells: number;
  dataBytes: number;
  rows: number;
}

addEventListener('message', async (event: MessageEvent<NativeSinkWorkerRunMessage>) => {
  const message = event.data;
  try {
    const result = await sinkShard(message);
    postMessage({
      ...result,
      type: 'done',
      workerIndex: message.workerIndex,
    });
  } catch (error) {
    postMessage({
      error: error instanceof Error ? error.message : String(error),
      type: 'error',
      workerIndex: message.workerIndex,
    });
  }
});

async function sinkShard(message: NativeSinkWorkerRunMessage): Promise<NativeSinkResult> {
  const parser = new NativeCsvParser({ delimiter: message.delimiter });
  let rows = 0;
  let cells = 0;
  let dataBytes = 0;
  try {
    for await (
      const chunk of createReadStream(message.path, {
        start: message.shard.start,
        end: message.shard.end,
        highWaterMark: message.chunkSize,
      })
    ) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        rows += batch.rowCount;
        cells += batch.totalFields;
        dataBytes += batch.dataLength;
      } finally {
        batch.close();
      }
    }

    const batch = parser.endBatch();
    try {
      rows += batch.rowCount;
      cells += batch.totalFields;
      dataBytes += batch.dataLength;
    } finally {
      batch.close();
    }
    return { cells, dataBytes, rows };
  } finally {
    parser.close();
  }
}
