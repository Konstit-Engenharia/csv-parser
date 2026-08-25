import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  csv,
  type CsvFilter,
  type CsvNativeFilter,
  type CsvRegex,
  NativeCsvParser,
} from '../src/index.ts';
import { normalizeNativeFilters } from '../src/normalize.ts';
import { csvFixturePath } from './fixtures.ts';

describe('native RE2 filters', () => {
  test('creates an opaque immutable regex with csv.re()', () => {
    const regex: CsvRegex = csv.re(/^sp$/iu);

    expect({ flags: regex.flags, source: regex.source }).toEqual({ flags: 'iu', source: '^sp$' });
    expect(Object.isFrozen(regex)).toBe(true);
  });

  test('rejects unsupported flags, unsupported syntax, and oversized patterns', () => {
    expect(() => csv.re(/SP/g)).toThrow('unsupported regular expression flags: g');
    expect(() => csv.re(/(?=SP)/)).toThrow('invalid perl operator');
    expect(() => csv.re(new RegExp('a'.repeat(4_097)))).toThrow('regular expression exceeds 4096 UTF-8 bytes');
    expect(() => csv.column(0).hasMatch(/SP/g)).toThrow('unsupported regular expression flags: g');
    expect(() => csv.column(0).hasMatch(/(?=SP)/)).toThrow('invalid perl operator');
    expect(() => csv.column(0).hasMatch(new RegExp('a'.repeat(4_097)))).toThrow(
      'regular expression exceeds 4096 UTF-8 bytes',
    );
  });

  test('propagates native validation errors for forged regex descriptors', () => {
    const invalid = { flags: '', source: '(?=SP)' } as unknown as CsvRegex;
    using parser = new NativeCsvParser();

    expect(() => parser.writeCountWhereAll(Buffer.from('SP\n'), [{ column: 0, regex: invalid }], true)).toThrow(
      'invalid perl operator',
    );
  });

  test('uses search semantics and preserves supported flags', async () => {
    const path = csvFixturePath('api/unquoted-people-sp-filter.csv');

    expect(await csv.count(path, { delimiter: ';', where: csv.column(1).hasMatch(/ao/) })).toBe(1);
    expect(await csv.count(path, { delimiter: ';', where: csv.column(2).hasMatch(/^sp$/i) })).toBe(2);
    expect(
      await csv.count(csvFixturePath('api/quoted-people-multiline-state.csv'), {
        delimiter: ';',
        where: csv.column(2).hasMatch(/^S.P$/s),
      }),
    ).toBe(1);

    expect(
      await csv.parse(Buffer.from('.\nx\n'), {
        where: csv.column(0).hasMatch(/\u002e/u),
      }),
    ).toEqual([['.']]);
  });

  test('matches UTF-8 fields and mixed AND filters across chunks', () => {
    const input = Buffer.from('1;São Paulo;SP\n2;Santos;SP\n3;Bia;RJ\n');
    const filters = [
      { column: 1, regex: csv.re(/^São/u) },
      { column: 2, regex: csv.re(/^(?:SP|RJ)$/) },
      { column: 0, prefix: '1' },
    ] satisfies readonly CsvNativeFilter[];
    using parser = new NativeCsvParser({ delimiter: ';' });

    let count = parser.writeCountWhereAll(input.subarray(0, 7), filters);
    count += parser.writeCountWhereAll(input.subarray(7, 19), filters);
    count += parser.writeCountWhereAll(input.subarray(19), filters);
    count += parser.endCountWhereAll(filters);

    expect(count).toBe(1);
  });

  test('supports regex filters in worker count, rows, and reusable pools', async () => {
    const path = csvFixturePath('api/quoted-people-sp-filter.csv');
    const stateFilter = csv.column(2).hasMatch(/^(?:SP|RJ)$/);

    expect(
      await csv.count(path, {
        delimiter: ';',
        workerCount: 2,
        where: stateFilter,
      }),
    ).toBe(3);

    const rows: string[][] = [];
    for await (
      const batch of csv.rows(path, {
        columns: [0, 1] as const,
        delimiter: ';',
        workerCount: 2,
        where: csv.column(1).hasMatch(/^b/i),
      })
    ) {
      rows.push(...batch);
    }
    expect(rows).toEqual([['3', 'Bia']]);

    using pool = csv.workerPool(path, {
      columns: [0, 1] as const,
      delimiter: ';',
      workerCount: 2,
      where: stateFilter,
    });
    expect(await pool.count()).toBe(3);
    const pooledRows: string[][] = [];
    for await (const batch of pool.rows()) {
      pooledRows.push(...batch);
    }
    expect(pooledRows.map((row) => row.join('|')).sort()).toEqual(['1|Ana', '2|Joao', '3|Bia']);
  });

  test('limits native regex filters per operation', () => {
    const regex = csv.re(/x/);
    expect(() => normalizeNativeFilters(Array.from({ length: 33 }, () => ({ column: 0, regex })))).toThrow(
      'regex filter count out of range: 33',
    );
  });

  test('limits composed regex filters when the filter is constructed', () => {
    const combine = csv.all as unknown as (...filters: CsvFilter[]) => CsvFilter;
    expect(() => combine(...Array.from({ length: 33 }, () => csv.column(0).hasMatch(/x/)))).toThrow(
      'regex filter count out of range: 33',
    );
  });
});
