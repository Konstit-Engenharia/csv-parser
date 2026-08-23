import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  parallelCount,
  parallelRows,
  workerPool,
} from '../src/api.ts';
import { withWorkerFactoryForTests } from '../src/worker-factory.js';
import { csvFixturePath } from './fixtures.ts';

const path = csvFixturePath('api/quoted-people-two-rows.csv');

type FakeWorker = Worker & {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminated: boolean;
};

function fakeWorker(): FakeWorker {
  const worker = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage() {},
    terminate() {
      worker.terminated = true;
    },
  } as unknown as FakeWorker;
  return worker;
}

async function collectRows(rows: AsyncIterable<string[][]>): Promise<string[][]> {
  const collected: string[][] = [];
  for await (const batch of rows) {
    collected.push(...batch);
  }
  return collected;
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('expected operation to reject');
}

describe('worker lifecycle regressions', () => {
  test('ignores a late count reply after an earlier operation error', async () => {
    const workers: FakeWorker[] = [];
    const postCounts: number[] = [];
    const factory = () => {
      const worker = fakeWorker();
      const workerIndex = workers.length;
      workers.push(worker);
      postCounts.push(0);
      worker.postMessage = () => {
        const postCount = (postCounts[workerIndex] ?? 0) + 1;
        postCounts[workerIndex] = postCount;
        if (workerIndex === 0 && postCount === 1) {
          worker.onmessage?.({ data: { type: 'error', shardIndex: 0, error: 'failed' } } as MessageEvent);
          return;
        }
        if (workerIndex === 1 && postCount === 2) {
          worker.onmessage?.({ data: { type: 'done', shardIndex: 1, rows: 100 } } as MessageEvent);
          workers[0]?.onmessage?.({ data: { type: 'done', shardIndex: 0, rows: 1 } } as MessageEvent);
          worker.onmessage?.({ data: { type: 'done', shardIndex: 1, rows: 1 } } as MessageEvent);
          return;
        }
        if (workerIndex >= 2) {
          worker.onmessage?.({ data: { type: 'done', shardIndex: workerIndex % 2, rows: 1 } } as MessageEvent);
        }
      };
      return worker;
    };
    await withWorkerFactoryForTests(factory, async () => {
      using pool = workerPool(path, { delimiter: ';', workerCount: 2 });
      expect((await rejectedError(pool.count())).message).toContain('failed');
      expect(await pool.count()).toBe(2);
    });
  });

  test('close terminates active count and pending rows workers', async () => {
    const workers: FakeWorker[] = [];
    await withWorkerFactoryForTests(() => {
      const worker = fakeWorker();
      workers.push(worker);
      return worker;
    }, async () => {
      const pool = workerPool(path, { delimiter: ';', workerCount: 2 });
      const count = pool.count();
      pool.close();
      expect(workers.every((worker) => worker.terminated)).toBe(true);
      expect((await rejectedError(count)).message).toContain('worker pool is closed');
      const rowsPool = workerPool(path, { delimiter: ';', workerCount: 2 });
      const rows = rowsPool.rows();
      const pending = rows.next();
      rowsPool.close();
      expect((await rejectedError(pending)).message).toContain('worker pool is closed');
    });
  });

  test('terminates partially constructed worker sets', async () => {
    for (
      const operation of [
        () => parallelCount(path, { delimiter: ';', workerCount: 2 }),
        () =>
          (async () => {
            for await (const _rows of parallelRows(path, { delimiter: ';', workerCount: 2 })) {
            }
          })(),
        () => workerPool(path, { delimiter: ';', workerCount: 2 }).count(),
        () => workerPool(path, { delimiter: ';', workerCount: 2 }).rows().next(),
      ]
    ) {
      const workers: FakeWorker[] = [];
      const factory = () => {
        const worker = fakeWorker();
        workers.push(worker);
        if (workers.length === 2) {
          throw new Error('construction failed');
        }
        return worker;
      };
      await withWorkerFactoryForTests(factory, async () => {
        expect((await rejectedError(operation())).message).toContain('construction failed');
        expect(workers[0]?.terminated).toBe(true);
      });
    }
  });

  test('early pooled rows return terminates its workers before the next call', async () => {
    const workers: FakeWorker[] = [];
    const postCounts: number[] = [];
    const factory = () => {
      const worker = fakeWorker();
      const workerIndex = workers.length;
      workers.push(worker);
      postCounts.push(0);
      worker.postMessage = () => {
        const postCount = (postCounts[workerIndex] ?? 0) + 1;
        postCounts[workerIndex] = postCount;
        if (workerIndex === 0 && postCount === 1) {
          worker.onmessage?.({ data: { type: 'rows', rows: [['old-first']] } } as MessageEvent);
          return;
        }
        if (workerIndex < 2 && postCount === 2) {
          if (workerIndex === 0) {
            worker.onmessage?.({ data: { type: 'rows', rows: [['old-late']] } } as MessageEvent);
          }
          worker.onmessage?.({ data: { type: 'done' } } as MessageEvent);
          return;
        }
        if (workerIndex >= 2) {
          if (workerIndex === 2) {
            worker.onmessage?.({ data: { type: 'rows', rows: [['new']] } } as MessageEvent);
          }
          worker.onmessage?.({ data: { type: 'done' } } as MessageEvent);
        }
      };
      return worker;
    };
    await withWorkerFactoryForTests(factory, async () => {
      using pool = workerPool(path, { delimiter: ';', workerCount: 2 });
      const iterator = pool.rows();
      expect((await iterator.next()).value).toEqual([['old-first']]);
      await iterator.return?.();
      expect(workers.slice(0, 2).every((worker) => worker.terminated)).toBe(true);
      expect(await collectRows(pool.rows())).toEqual([['new']]);
    });
  });
});
