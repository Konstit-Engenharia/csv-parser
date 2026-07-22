import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../../src/index.ts';
import type { CsvColumns } from '../../src/types.ts';
import type { TrustedShard } from './common.ts';

type MaterializeMode = 'message-final' | 'shared-progress';

interface MaterializeWorkerRunMessage {
  chunkSize: number;
  delimiter: string;
  mode: MaterializeMode;
  path: string;
  projection: boolean;
  selectedColumns?: CsvColumns;
  shard: TrustedShard;
  sharedCounts?: SharedArrayBuffer;
  workerIndex: number;
}

addEventListener('message', async (event: MessageEvent<MaterializeWorkerRunMessage>) => {
  const message = event.data;
  try {
    const rows = await materializeShard(message);
    postMessage({
      type: 'done',
      rows,
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

async function materializeShard(message: MaterializeWorkerRunMessage): Promise<number> {
  using parser = new NativeCsvParser({ delimiter: message.delimiter });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  const sharedCounts = message.sharedCounts === undefined ? undefined : new Int32Array(message.sharedCounts);
  for await (
    const chunk of createReadStream(message.path, {
      start: message.shard.start,
      end: message.shard.end,
      highWaterMark: message.chunkSize,
    })
  ) {
    using batch = message.projection
      ? parser.writeProjectedBatch(chunk as Buffer, { selectedColumns: message.selectedColumns })
      : parser.writeBatch(chunk as Buffer);
    rows += message.projection
      ? batch.rowsInto(rowsBuffer).length
      : batch.rowsInto(rowsBuffer, message.selectedColumns).length;
    if (sharedCounts !== undefined) {
      Atomics.add(sharedCounts, message.workerIndex, batch.rowCount);
    }
  }

  using batch = message.projection
    ? parser.endProjectedBatch({ selectedColumns: message.selectedColumns })
    : parser.endBatch();
  rows += message.projection
    ? batch.rowsInto(rowsBuffer).length
    : batch.rowsInto(rowsBuffer, message.selectedColumns).length;
  if (sharedCounts !== undefined && batch.rowCount > 0) {
    Atomics.add(sharedCounts, message.workerIndex, batch.rowCount);
  }
  return rows;
}
