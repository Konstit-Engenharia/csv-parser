import {
  describe,
  expect,
  test,
} from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csv } from '../src/index.ts';

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

  test('counts rows with fluent filters and trusted fixed-column shortcut', async () => {
    const path = await writeFixture('id;name;uf\n1;Ana;SP\n2;Joao;RJ\n3;Bia;SP\n');

    expect(await csv.file(path).delimiter(';').trustedFixedColumns(3).count()).toBe(4);
    expect(await csv.file(path).delimiter(';').whereEquals(2, 'SP').count()).toBe(2);
    expect(await csv.file(path).delimiter(';').whereIn(2, ['SP', 'RJ']).count()).toBe(3);
    expect(await csv.file(path).delimiter(';').whereStartsWith(1, 'A').count()).toBe(1);
  });

  test('runs callback-owned batches and row view aliases', async () => {
    const path = await writeFixture('1;Ana;SP\n2;Joao;RJ\n');
    const seen: string[][] = [];

    await csv.file(path).delimiter(';').withBatches((batch) => {
      batch.forEachRow((row) => {
        seen.push([row.get(0) ?? '', row.bytes(1)?.toString() ?? '', ...row.pick([2])]);
        expect(row.range(2)).not.toBeNull();
      });
    });

    expect(seen).toEqual([
      ['1', 'Ana', 'SP'],
      ['2', 'Joao', 'RJ'],
    ]);
  });

  test('keeps unsupported row filters explicit', async () => {
    const path = await writeFixture('1;Ana;SP\n');

    let error: unknown;
    try {
      for await (const _rows of csv.file(path).delimiter(';').whereIn(2, ['SP']).rows()) {
        throw new Error('unreachable');
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('rows() supports only where.equals');
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

  test('keeps strict unsupported aggregate paths explicit', async () => {
    const path = await writeFixture('id,name\n1,Ada\n');

    let countError: unknown;
    try {
      await csv.count(path, { strict: true });
    } catch (caught) {
      countError = caught;
    }
    expect(countError).toBeInstanceOf(Error);
    expect((countError as Error).message).toContain('strict CSV validation is not supported for count');

    let projectedError: unknown;
    try {
      for await (const _rows of csv.rows(path, { strict: true, columns: [0], where: { column: 1, equals: 'Ada' } })) {
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
