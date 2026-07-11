import {
  countTrustedShardRows,
  type TrustedShard,
} from './common.ts';

type WorkerMode = 'message-final' | 'message-progress' | 'shared-progress';

interface WorkerRunMessage {
  chunkSize: number;
  delimiter: string;
  fixedColumns: number;
  mode: WorkerMode;
  path: string;
  shard: TrustedShard;
  workerIndex: number;
  sharedCounts?: SharedArrayBuffer;
}

addEventListener('message', async (event: MessageEvent<WorkerRunMessage>) => {
  const message = event.data;
  try {
    switch (message.mode) {
      case 'message-final': {
        const rows = await countTrustedShardRows(message);
        postMessage({
          type: 'done',
          rows,
          workerIndex: message.workerIndex,
        });
        return;
      }
      case 'message-progress': {
        let rows = 0;
        await countTrustedShardRows({
          ...message,
          onBatchRows(batchRows) {
            rows += batchRows;
            postMessage({
              type: 'progress',
              rows: batchRows,
              workerIndex: message.workerIndex,
            });
          },
        });
        postMessage({
          type: 'done',
          rows,
          workerIndex: message.workerIndex,
        });
        return;
      }
      case 'shared-progress': {
        if (message.sharedCounts === undefined) {
          throw new Error('shared-progress requires sharedCounts');
        }
        const sharedCounts = new Int32Array(message.sharedCounts);
        let rows = 0;
        await countTrustedShardRows({
          ...message,
          onBatchRows(batchRows) {
            rows += batchRows;
            Atomics.add(sharedCounts, message.workerIndex, batchRows);
          },
        });
        postMessage({
          type: 'done',
          rows,
          workerIndex: message.workerIndex,
        });
      }
    }
  } catch (error) {
    postMessage({
      error: error instanceof Error ? error.message : String(error),
      type: 'error',
      workerIndex: message.workerIndex,
    });
  }
});
