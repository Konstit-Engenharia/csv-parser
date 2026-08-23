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
import type {
  CsvParallelCountOptions,
  CsvParallelRowsOptions,
  CsvWorkerPoolOptions,
} from '../src/types.ts';
import { withWorkerFactoryForTests } from '../src/worker-factory.js';
import { csvFixturePath } from './fixtures.ts';

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

describe('worker API coverage', () => {
  test('covers deterministic worker error, overflow, and duplicate settlement paths', async () => {
    const path = csvFixturePath('api/quoted-people-two-rows.csv');
    type Fake = {
      onmessage: ((event: MessageEvent) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
      postMessage: (message: { readonly shardIndex: number; }) => void;
      terminate: () => void;
    };
    let mode = 'error';
    const factory = () => {
      const worker: Fake = {
        onmessage: null,
        onerror: null,
        postMessage(message) {
          if (mode === 'onerror') {
            worker.onerror?.({ error: new Error('boom') } as ErrorEvent);
          } else if (mode === 'fallback') {
            worker.onerror?.({ error: 'boom' } as ErrorEvent);
          } else if (mode === 'overflow') {
            worker.onmessage?.({ data: { type: 'done', rows: Number.MAX_SAFE_INTEGER } } as MessageEvent);
          } else {
            worker.onmessage?.({ data: { type: 'error', shardIndex: message.shardIndex, error: 'bad' } } as MessageEvent);
          }
          worker.onmessage?.({ data: { type: 'done', rows: mode === 'overflow' ? Number.MAX_SAFE_INTEGER : 0 } } as MessageEvent);
        },
        terminate() {},
      };
      return worker as unknown as Worker;
    };
    await withWorkerFactoryForTests(factory, async () => {
      expect((await rejectedError(parallelCount(path, { delimiter: ';', workerCount: 2 }))).message).toContain('worker 0: bad');
      mode = 'overflow';
      expect((await rejectedError(parallelCount(path, { delimiter: ';', workerCount: 2 }))).message).toContain('exceeds');
      mode = 'onerror';
      expect((await rejectedError(parallelCount(path, { delimiter: ';', workerCount: 2 }))).message).toBe('boom');
      mode = 'fallback';
      expect((await rejectedError(collectRows(parallelRows(path, { delimiter: ';', workerCount: 2 })))).message).toBe('worker 0 failed');
      mode = 'error';
      using pool = workerPool(path, { delimiter: ';', workerCount: 2 });
      expect((await rejectedError(pool.count())).message).toContain('worker 0: bad');
      expect((await rejectedError(collectRows(pool.rows()))).message).toContain('worker 0: bad');
      mode = 'onerror';
      using errorPool = workerPool(path, { delimiter: ';', workerCount: 2 });
      expect((await rejectedError(errorPool.count())).message).toBe('boom');
      expect((await rejectedError(collectRows(errorPool.rows()))).message).toBe('boom');
    });
  });
  test('validates direct worker counts and handles empty files', async () => {
    const emptyPath = csvFixturePath('empty.csv');

    expect((await rejectedError(parallelCount(emptyPath, { workerCount: 1 }))).message).toContain(
      'parallel count require workerCount > 1: 1',
    );
    expect(
      (await rejectedError(parallelCount(emptyPath, { workerCount: 1.5 } as CsvParallelCountOptions))).message,
    ).toContain('parallel count require workerCount > 1: 1.5');
    expect(
      (await rejectedError(collectRows(parallelRows(emptyPath, { workerCount: 1 })))).message,
    ).toContain('parallel rows require workerCount > 1: 1');

    expect(await parallelCount(emptyPath, { workerCount: 2 })).toBe(0);
    expect(await collectRows(parallelRows(emptyPath, { workerCount: 2 }))).toEqual([]);
    expect((await rejectedError(collectRows(parallelRows(emptyPath, { workerCount: 2, where: { all: [] } })))).message)
      .toContain('where.all must contain at least one filter');

    const pool = workerPool(emptyPath, { workerCount: 2 });
    expect(pool.closed).toBe(false);
    expect(await pool.count()).toBe(0);
    expect(await collectRows(pool.rows())).toEqual([]);
    pool.close();
    expect(pool.closed).toBe(true);
    pool.close();
  });

  test('validates direct and pooled worker options before parsing', async () => {
    const path = csvFixturePath('api/unquoted-one-person-no-header.csv');
    const emptyNotIn = { column: 0, notIn: [] } as const;

    expect((await rejectedError(parallelCount(path, { workerCount: 2, where: emptyNotIn }))).message).toContain(
      'filter values must not be empty',
    );
    expect(
      (await rejectedError(collectRows(parallelRows(path, { workerCount: 2, where: emptyNotIn })))).message,
    ).toContain('filter values must not be empty');

    using pool = workerPool(path, { workerCount: 2, where: emptyNotIn });
    expect((await rejectedError(pool.count())).message).toContain('filter values must not be empty');
    expect((await rejectedError(collectRows(pool.rows()))).message).toContain('filter values must not be empty');

    const conflictingColumns = {
      columns: [0],
      selectedColumns: [0],
      workerCount: 2,
    } as unknown as CsvParallelRowsOptions;
    expect((await rejectedError(collectRows(parallelRows(path, conflictingColumns)))).message).toContain(
      'use columns or selectedColumns, not both',
    );

    using conflictingPool = workerPool(path, conflictingColumns as unknown as CsvWorkerPoolOptions);
    expect((await rejectedError(collectRows(conflictingPool.rows()))).message).toContain(
      'use columns or selectedColumns, not both',
    );

    const strictPoolOptions = { strict: true, workerCount: 2 } as unknown as CsvWorkerPoolOptions;
    using strictPool = workerPool(path, strictPoolOptions);
    expect((await rejectedError(strictPool.count())).message).toContain(
      'parallel count does not support strict CSV validation',
    );
    expect((await rejectedError(collectRows(strictPool.rows()))).message).toContain(
      'parallel rows do not support strict CSV validation',
    );
  });

  test('accepts binary filter values through direct and pooled workers', async () => {
    const path = csvFixturePath('api/unquoted-one-person-no-header.csv');
    const where = { column: 0, equals: Buffer.from('1') } as const;

    expect(await parallelCount(path, { delimiter: ';', workerCount: 2, where })).toBe(1);
    expect(await collectRows(parallelRows(path, { delimiter: ';', workerCount: 2, where }))).toEqual([
      ['1', 'Ana', 'SP'],
    ]);

    using pool = workerPool(path, { delimiter: ';', workerCount: 2, where });
    expect(await pool.count()).toBe(1);
    expect(await collectRows(pool.rows())).toEqual([['1', 'Ana', 'SP']]);
  });

  test('propagates worker-reported failures and rejects concurrent pool use', async () => {
    const path = csvFixturePath('api/unquoted-one-person-no-header.csv');
    const invalidEncoding = { encoding: 'invalid', workerCount: 2 } as unknown as CsvParallelCountOptions;

    expect((await rejectedError(parallelCount(path, invalidEncoding))).message).toContain('unsupported encoding: invalid');
    expect(
      (await rejectedError(collectRows(parallelRows(path, invalidEncoding as unknown as CsvParallelRowsOptions)))).message,
    ).toContain('unsupported encoding: invalid');

    using invalidPool = workerPool(path, invalidEncoding as unknown as CsvWorkerPoolOptions);
    expect((await rejectedError(invalidPool.count())).message).toContain('unsupported encoding: invalid');
    expect((await rejectedError(collectRows(invalidPool.rows()))).message).toContain('unsupported encoding: invalid');

    using pool = workerPool(path, { delimiter: ';', workerCount: 2 });
    const firstCount = pool.count();
    expect((await rejectedError(pool.count())).message).toContain('worker pool is busy');
    expect(await firstCount).toBe(1);
  });
});
