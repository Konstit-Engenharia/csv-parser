import {
  describe,
  expect,
  test,
} from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  csv,
  type CsvApiFileOptions,
  type CsvCountOptions,
  type CsvRowsOptions,
} from '../src/index.ts';

describe('csv high-level API', () => {
  test('streams selected rows with equals filter', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"SP"\n');
    const batches: string[][][] = [];

    for await (
      const rows of csv.rows(path, {
        delimiter: ';',
        columns: [0, 1] as const,
        where: { column: 2, equals: 'SP' },
      })
    ) {
      batches.push(rows);
    }

    expect(batches.flat()).toEqual([
      ['1', 'Ana'],
      ['3', 'Bia'],
    ]);
  });

  test('streams selected rows without materializing skipped columns', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n');
    const rows: string[][] = [];

    for await (
      const batch of csv.rows(path, {
        delimiter: ';',
        columns: [0, 2] as const,
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
  });

  test('streams selected rows with string cache', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Bia";"SP"\n"3";"Caio";"RJ"\n');
    const rows: string[][] = [];

    for await (
      const batch of csv.file(path)
        .delimiter(';')
        .select([0, 2] as const)
        .stringCache([2])
        .rows()
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
      ['2', 'SP'],
      ['3', 'RJ'],
    ]);
  });

  test('keeps builder immutable across divergent chains', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Bia";"RJ"\n');
    const base = csv.file(path).delimiter(';');
    const selected = base.select([0, 2] as const);
    const baseRows: string[][] = [];
    const selectedRows: string[][] = [];

    for await (const batch of base.rows()) {
      baseRows.push(...batch);
    }

    for await (const batch of selected.rows()) {
      selectedRows.push(...batch);
    }

    expect(baseRows).toEqual([
      ['id', 'name', 'uf'],
      ['1', 'Ana', 'SP'],
      ['2', 'Bia', 'RJ'],
    ]);
    expect(selectedRows).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
  });

  test('replaces column aliases without leaving conflicting builder state', async () => {
    const path = await writeFixture('id,name,uf\n1,Ada,SP\n');
    const builder = csv.file(path, { selectedColumns: [0, 2] as const }).select([1] as const);
    const rows: string[][] = [];

    for await (const batch of builder.rows()) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['name'],
      ['Ada'],
    ]);
  });

  test('rejects invalid worker counts at builder configuration time', () => {
    expect(() => csv.file('unused.csv').workers(1)).toThrow('workers requires workerCount > 1: 1');
    expect(() => csv.file('unused.csv').workers(1.5)).toThrow('workers requires workerCount > 1: 1.5');
  });

  test('streams rows through workers with shard-safe splitting', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"S\nP"\n"4";"Caio";"SP"\n');
    const rows: string[][] = [];

    for await (
      const batch of csv.file(path)
        .delimiter(';')
        .select([0, 2] as const)
        .workers(2)
        .rows()
    ) {
      rows.push(...batch);
    }

    expect(rows.map((row) => row.join('|')).sort()).toEqual([
      '1|SP',
      '2|RJ',
      '3|S\nP',
      '4|SP',
      'id|uf',
    ]);
  });

  test('streams filtered rows through workers with equals filter', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"SP"\n');
    const rows: string[][] = [];

    for await (
      const batch of csv.file(path)
        .delimiter(';')
        .select([0, 1] as const)
        .whereEquals(2, 'SP')
        .workers(2)
        .rows()
    ) {
      rows.push(...batch);
    }

    expect(rows.map((row) => row.join('|')).sort()).toEqual([
      '1|Ana',
      '3|Bia',
    ]);
  });

  test('streams selected rows through workers with string cache', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Bia";"SP"\n"3";"Caio";"RJ"\n');
    const rows: string[][] = [];

    for await (
      const batch of csv.file(path)
        .delimiter(';')
        .select([0, 2] as const)
        .stringCache([2])
        .workers(2)
        .rows()
    ) {
      rows.push(...batch);
    }

    expect(rows.map((row) => row.join('|')).sort()).toEqual([
      '1|SP',
      '2|SP',
      '3|RJ',
      'id|uf',
    ]);
  });

  test('counts rows with fluent filters and trusted fixed-column shortcut', async () => {
    const path = await writeFixture('id;name;uf\n1;Ana;SP\n2;Joao;RJ\n3;Bia;SP\n');

    expect(await csv.file(path).delimiter(';').trustedFixedColumns(3).count()).toBe(4);
    expect(await csv.file(path).delimiter(';').whereEquals(2, 'SP').count()).toBe(2);
    expect(await csv.file(path).delimiter(';').whereIn(2, ['SP', 'RJ']).count()).toBe(3);
    expect(await csv.file(path).delimiter(';').whereStartsWith(1, 'A').count()).toBe(1);
  });

  test('counts rows through workers with native shard splitting', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"S\nP"\n"4";"Caio";"SP"\n');

    expect(await csv.file(path).delimiter(';').workers(2).count()).toBe(5);
    expect(await csv.file(path).delimiter(';').workers(2).whereEquals(2, 'SP').count()).toBe(2);
    expect(await csv.file(path).delimiter(';').workers(2).whereIn(2, ['SP', 'RJ']).count()).toBe(3);
    expect(await csv.file(path).delimiter(';').workers(2).whereStartsWith(1, 'A').count()).toBe(1);
  });

  test('aggregates groupBy count through workers with shard-safe splitting', async () => {
    const path = await writeFixture('"id";"uf"\n"1";"SP"\n"2";"RJ"\n"3";"S\nP"\n"4";"SP"\n');
    const batch = await csv.file(path).delimiter(';').workers(2).groupByCount(1);
    try {
      expect(batch.rowCount).toBe(5);
      expect(batch.entries()).toEqual([
        { value: 'uf', count: 1 },
        { value: 'SP', count: 2 },
        { value: 'RJ', count: 1 },
        { value: 'S\nP', count: 1 },
      ]);
    } finally {
      batch.close();
    }
  });

  test('aggregates column stats through workers preserving row order', async () => {
    const path = await writeFixture('"id";"uf"\n"1";"SP"\n"2";"RJ"\n"3";"S\nP"\n"4";"SP"\n');
    const batch = await csv.file(path).delimiter(';').workers(2).columnStats(1);
    try {
      expect(batch.rowCount).toBe(5);
      expect(batch.entries()).toEqual([
        { value: 'uf', count: 1 },
        { value: 'SP', count: 2 },
        { value: 'RJ', count: 1 },
        { value: 'S\nP', count: 1 },
      ]);
      expect([...batch.ids()]).toEqual([0, 1, 2, 3, 1]);
    } finally {
      batch.close();
    }
  });

  test('aggregates multi-column stats through workers', async () => {
    const path = await writeFixture('"id";"uf";"kind"\n"1";"SP";"A"\n"2";"RJ";"B"\n"3";"SP";"A"\n');
    const batches = await csv.file(path).delimiter(';').workers(2).multiColumnStats([1, 2]);
    try {
      expect(batches.map((batch) => batch.column)).toEqual([1, 2]);
      expect(batches[0]?.entries()).toEqual([
        { value: 'uf', count: 1 },
        { value: 'SP', count: 2 },
        { value: 'RJ', count: 1 },
      ]);
      expect(batches[1]?.entries()).toEqual([
        { value: 'kind', count: 1 },
        { value: 'A', count: 2 },
        { value: 'B', count: 1 },
      ]);
    } finally {
      for (const batch of batches) {
        batch.close();
      }
    }
  });

  test('reuses worker pool across repeated count and rows calls', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"SP"\n');
    using pool = csv.file(path)
      .delimiter(';')
      .workers(2)
      .select([0, 1] as const)
      .pool();

    expect(await pool.count()).toBe(4);
    expect(await pool.count()).toBe(4);

    const seenA: string[][] = [];
    for await (const rows of pool.rows()) {
      seenA.push(...rows);
    }

    const seenB: string[][] = [];
    for await (const rows of pool.rows()) {
      seenB.push(...rows);
    }

    expect(seenA.map((row) => row.join('|')).sort()).toEqual([
      '1|Ana',
      '2|Joao',
      '3|Bia',
      'id|name',
    ]);
    expect(seenB.map((row) => row.join('|')).sort()).toEqual(seenA.map((row) => row.join('|')).sort());
  });

  test('reuses worker pool across aggregate calls', async () => {
    const path = await writeFixture('"id";"uf";"kind"\n"1";"SP";"A"\n"2";"RJ";"B"\n"3";"SP";"A"\n');
    using pool = csv.file(path).delimiter(';').workers(2).pool();

    const groupA = await pool.groupByCount(1);
    const groupB = await pool.groupByCount(1);
    const stats = await pool.columnStats(2);
    const multi = await pool.multiColumnStats([1, 2]);

    try {
      expect(groupA.entries()).toEqual([
        { value: 'uf', count: 1 },
        { value: 'SP', count: 2 },
        { value: 'RJ', count: 1 },
      ]);
      expect(groupB.entries()).toEqual(groupA.entries());
      expect(stats.entries()).toEqual([
        { value: 'kind', count: 1 },
        { value: 'A', count: 2 },
        { value: 'B', count: 1 },
      ]);
      expect([...stats.ids()]).toEqual([0, 1, 2, 1]);
      expect(multi.map((batch) => batch.entries())).toEqual([
        [
          { value: 'uf', count: 1 },
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
        ],
        [
          { value: 'kind', count: 1 },
          { value: 'A', count: 2 },
          { value: 'B', count: 1 },
        ],
      ]);
    } finally {
      groupA.close();
      groupB.close();
      stats.close();
      for (const batch of multi) {
        batch.close();
      }
    }
  });

  test('runs safe row view callbacks through builder and top-level alias', async () => {
    const path = await writeFixture('1;Ana;SP\n2;Joao;RJ\n');
    const seen: string[][] = [];
    const aliasSeen: string[][] = [];
    const physicalSeen: string[][] = [];
    let firstRowView: unknown;
    let escapedRowView: Parameters<Parameters<typeof csv.withRowViews>[2]>[0] | undefined;

    await csv.file(path).delimiter(';').forEachRowViews((row, rowIndex) => {
      if (rowIndex === 0) {
        firstRowView = row;
      } else {
        expect(row === firstRowView).toBe(true);
      }
      escapedRowView = row;
      seen.push([row.get(0) ?? '', row.bytes(1)?.toString() ?? '', ...row.pick([2])]);
      physicalSeen.push([row.getPhysical(0) ?? '', ...row.pickPhysical([2])]);
      expect(row.range(2)).not.toBeNull();
    });

    await csv.withRowViews(path, { delimiter: ';' }, (row) => {
      aliasSeen.push([row.get(0) ?? '', row.get(2) ?? '']);
    });

    expect(seen).toEqual([
      ['1', 'Ana', 'SP'],
      ['2', 'Joao', 'RJ'],
    ]);
    expect(aliasSeen).toEqual([
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
    expect(physicalSeen).toEqual([
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
    expect(escapedRowView).toBeDefined();
    expect(() => escapedRowView?.getPhysical(0)).toThrow('row view is only valid during row view callback');
  });

  test('streams row views without materializing arrays', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n');
    const seen: string[] = [];
    const selectedColumnsSeen: Array<readonly number[] | undefined> = [];

    await csv.file(path).delimiter(';').select([0, 2] as const).withRowViews((row) => {
      selectedColumnsSeen.push(row.selectedColumns);
      seen.push(`${row.get(0)}|${row.get(2)}`);
    });

    expect(seen).toEqual([
      'id|uf',
      '1|SP',
      '2|RJ',
    ]);
    expect(selectedColumnsSeen).toEqual([
      [0, 2],
      [0, 2],
      [0, 2],
    ]);
  });

  test('streams columnar batches without per-field strings', async () => {
    const path = await writeFixture('"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n');
    const seen: string[] = [];
    const ranged: string[] = [];
    const scanned: string[] = [];
    const partial: string[] = [];
    let retained: unknown;

    await csv.file(path).delimiter(';').select([0, 2] as const).withColumnarBatches((batch) => {
      retained = batch;
      expect(batch.selectedColumns).toEqual([0, 2]);
      expect(batch.rowCount).toBeGreaterThan(0);
      const data = batch.data();
      for (let rowIndex = 0; rowIndex < batch.rowCount; ++rowIndex) {
        const left = batch.fieldBuffer(rowIndex, 0)?.toString() ?? '';
        const right = batch.fieldBuffer(rowIndex, 1)?.toString() ?? '';
        seen.push(`${left}|${right}`);
      }
      batch.forEachColumnRange(1, (rowIndex, start, end) => {
        ranged.push(`${rowIndex}:${data.toString('utf8', start, end)}`);
      });
      batch.scanColumns([0, 1], (rowIndex, offsets, buffer) => {
        const left = offsets[0] === -1 ? '' : buffer.toString('utf8', offsets[0] ?? 0, offsets[1] ?? 0);
        const right = offsets[2] === -1 ? '' : buffer.toString('utf8', offsets[2] ?? 0, offsets[3] ?? 0);
        scanned.push(`${rowIndex}:${left}|${right}`);
      });
      batch.forEachColumnRange(
        0,
        (_rowIndex, start, end) => {
          partial.push(data.toString('utf8', start, end));
        },
        1,
        3,
      );
    });

    expect(seen).toEqual([
      'id|uf',
      '1|SP',
      '2|RJ',
    ]);
    expect(ranged).toEqual([
      '0:uf',
      '1:SP',
      '2:RJ',
    ]);
    expect(scanned).toEqual([
      '0:id|uf',
      '1:1|SP',
      '2:2|RJ',
    ]);
    expect(partial).toEqual([
      '1',
      '2',
    ]);
    expect(() => (retained as { rowOffsets(): Uint32Array; }).rowOffsets()).toThrow(
      'columnar batch view is only valid during columnar batch callback',
    );
    expect(() => (retained as { forEachColumnRange(columnIndex: number, callback: () => void): void; }).forEachColumnRange(0, () => {}))
      .toThrow(
        'columnar batch view is only valid during columnar batch callback',
      );
  });

  test('keeps unsupported row filters explicit', async () => {
    const path = await writeFixture('1;Ana;SP\n');
    const invalidRowsBuilder = csv.file(path).delimiter(';').whereIn(2, ['SP']) as unknown as {
      rows(): AsyncGenerator<string[][], void>;
    };

    let error: unknown;
    try {
      for await (const _rows of invalidRowsBuilder.rows()) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('rows() supports only where.equals');
  });

  test('keeps unsupported worker row modes explicit', async () => {
    const path = await writeFixture('1;Ana;SP\n');
    const invalidWorkerWhereBuilder = csv.file(path).delimiter(';').whereIn(2, ['SP']).workers(2) as unknown as {
      rows(): AsyncGenerator<string[][], void>;
    };
    const invalidStrictBuilder = csv.file(path).delimiter(';').strict().workers(2) as unknown as {
      rows(): AsyncGenerator<string[][], void>;
    };

    let strictError: unknown;
    try {
      for await (const _rows of invalidStrictBuilder.rows()) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      strictError = caught;
    }
    expect(strictError).toBeInstanceOf(Error);
    expect((strictError as Error).message).toContain('parallel rows do not support strict CSV validation');

    let whereInError: unknown;
    try {
      for await (const _rows of invalidWorkerWhereBuilder.rows()) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      whereInError = caught;
    }
    expect(whereInError).toBeInstanceOf(Error);
    expect((whereInError as Error).message).toContain('parallel rows support only where.equals');
  });

  test('keeps row view callback limits explicit', async () => {
    const path = await writeFixture('1;Ana;SP\n');
    const invalidRowViewsBuilder = csv.file(path).delimiter(';').workers(2) as unknown as {
      forEachRowViews(callback: () => void): Promise<void>;
    };

    const workerError = await rejectedError(
      invalidRowViewsBuilder.forEachRowViews(() => {
      }),
    );
    expect(workerError.message).toContain('row view callbacks do not support workerCount');

    const asyncCallback = (async () => {
    }) as unknown as Parameters<typeof csv.withRowViews>[2];

    const callbackError = await rejectedError(
      csv.withRowViews(path, { delimiter: ';' }, asyncCallback),
    );
    expect(callbackError.message).toContain('row view callback must be synchronous');
  });

  test('keeps unsupported worker count modes explicit', async () => {
    const path = await writeFixture('1;Ana;SP\n');
    const invalidCountBuilder = csv.file(path).delimiter(';').strict().workers(2) as unknown as {
      count(): Promise<number>;
    };

    let strictError: unknown;
    try {
      await invalidCountBuilder.count();
    } catch (caught) {
      strictError = caught;
    }
    expect(strictError).toBeInstanceOf(Error);
    expect((strictError as Error).message).toContain('parallel count does not support strict CSV validation');
  });

  test('keeps unsupported worker aggregate modes explicit', async () => {
    const path = await writeFixture('1;Ana;SP\n');
    const invalidGroupByBuilder = csv.file(path).delimiter(';').strict().workers(2) as unknown as {
      groupByCount(column: number): Promise<unknown>;
    };

    let strictGroupByError: unknown;
    try {
      await invalidGroupByBuilder.groupByCount(2);
    } catch (caught) {
      strictGroupByError = caught;
    }
    expect(strictGroupByError).toBeInstanceOf(Error);
    expect((strictGroupByError as Error).message).toContain('parallel groupByCount does not support strict CSV validation');
  });

  test('rejects use after worker pool close', async () => {
    const path = await writeFixture('id;name\n1;Ana\n');
    const pool = csv.file(path).delimiter(';').workers(2).pool();
    pool.close();

    const error = await rejectedError(pool.count());
    expect(error.message).toContain('worker pool is closed');
  });

  test('propagates strict mode to high-level row parsing', async () => {
    let error: unknown;
    try {
      await csv.parse(Buffer.from('id,name\n1,"Ada'), { strict: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('unterminated quoted field');
  });

  test('validates strict schema metadata in high-level rows', async () => {
    const path = await writeFixture('id;name;uf\n1;Ana;SP\n');
    const rows: string[][] = [];

    for await (
      const batch of csv.file(path)
        .delimiter(';')
        .strict()
        .expectedHeaders(['id', 'name', 'uf'])
        .minDataRows(1)
        .rows()
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['id', 'name', 'uf'],
      ['1', 'Ana', 'SP'],
    ]);
  });

  test('rejects strict schema metadata mismatch in high-level rows', async () => {
    const path = await writeFixture('id;full_name;uf\n1;Ana;SP\n');

    let error: unknown;
    try {
      for await (const _rows of csv.file(path).delimiter(';').strict().expectedHeaders(['id', 'name', 'uf']).rows()) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('strict CSV schema error: header mismatch at column 1');
  });

  test('counts strict rows without materializing strings', async () => {
    const path = await writeFixture('id,name\n1,Ada\n');

    expect(await csv.count(path, { strict: true })).toBe(2);
  });

  test('keeps strict selected rows supported', async () => {
    const path = await writeFixture('id,name,uf\n1,Ada,SP\n2,Bea,RJ\n');
    const rows: string[][] = [];

    for await (
      const batch of csv.rows(path, {
        columns: [0, 2] as const,
        delimiter: ',',
        strict: true,
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
  });

  test('keeps strict unsupported filtered and aggregate paths explicit', async () => {
    const path = await writeFixture('id,name\n1,Ada\n');

    let countError: unknown;
    try {
      const invalidOptions = { strict: true, where: { column: 1, equals: 'Ada' } } as CsvApiFileOptions;
      await csv.count(path, invalidOptions as unknown as CsvCountOptions);
    } catch (caught) {
      countError = caught;
    }
    expect(countError).toBeInstanceOf(Error);
    expect((countError as Error).message).toContain('strict CSV validation is not supported for count filters');

    let projectedError: unknown;
    try {
      const invalidOptions = { strict: true, columns: [0], where: { column: 1, equals: 'Ada' } } as CsvApiFileOptions;
      for await (const _rows of csv.rows(path, invalidOptions as CsvRowsOptions<number[]>)) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      projectedError = caught;
    }
    expect(projectedError).toBeInstanceOf(Error);
    expect((projectedError as Error).message).toContain('strict CSV validation is not supported for projected batches');
  });
});

async function writeFixture(data: string): Promise<string> {
  const path = join(tmpdir(), `csv-parser-api-${crypto.randomUUID()}.csv`);
  await Bun.write(path, data);
  return path;
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected promise to reject');
}
