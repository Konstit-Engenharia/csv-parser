import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  type CsvNativeFilter,
  NativeCsvParser,
} from '../src/index.ts';
import { normalizeNativeFilters } from '../src/normalize.ts';
import { readCsvFixture } from './fixtures.ts';

describe('NativeCsvParser multiple native filters', () => {
  test('packs mixed filters into native descriptors and values', () => {
    const normalized = normalizeNativeFilters([
      { column: 2, value: 'SP' },
      { column: 1, values: ['A', ''] },
      { column: 0, prefix: Buffer.from('x') },
    ]);

    expect(Array.from(normalized.descriptors)).toEqual([
      1,
      2,
      0,
      1,
      2,
      1,
      1,
      2,
      3,
      0,
      3,
      1,
    ]);
    expect(Buffer.from(normalized.valuesData.subarray(0, normalized.valuesDataLength)).toString()).toBe('SPAx');
    expect(Array.from(normalized.valueOffsets)).toEqual([0, 2, 3, 3, 4]);
    expect(normalized.filterCount).toBe(3);
    expect(normalized.valueCount).toBe(4);
  });

  test('counts rows that match every filter across chunks', () => {
    const filters = [
      { column: 2, values: ['SP', 'RJ'] },
      { column: 1, prefix: 'A' },
      { column: 0, value: '1' },
    ] satisfies readonly CsvNativeFilter[];
    const input = readCsvFixture('native/quoted-semicolon-people-with-mg.csv');
    using parser = new NativeCsvParser({ delimiter: ';' });

    let count = parser.writeCountWhereAll(input.subarray(0, 17), filters);
    count += parser.writeCountWhereAll(input.subarray(17), filters);
    count += parser.endCountWhereAll(filters);

    expect(count).toBe(1);
  });

  test('projects rows that match every filter', () => {
    const options = {
      filters: [
        { column: 2, values: ['SP', 'RJ'] },
        { column: 1, prefix: 'A' },
        { column: 0, value: '1' },
      ],
      selectedColumns: [2, 1],
    } satisfies Parameters<NativeCsvParser['writeProjectedBatch']>[1];
    const input = readCsvFixture('native/quoted-semicolon-people-with-mg.csv');
    using parser = new NativeCsvParser({ delimiter: ';' });
    const rows: string[][] = [];

    for (let offset = 0; offset < input.byteLength; ++offset) {
      using batch = parser.writeProjectedBatch(input.subarray(offset, offset + 1), options);
      rows.push(...batch.rows());
    }
    using finalBatch = parser.endProjectedBatch(options);
    rows.push(...finalBatch.rows());

    expect(rows).toEqual([['SP', 'Ana']]);
  });

  test('treats an empty native filter list as no filter', () => {
    using parser = new NativeCsvParser();
    const input = readCsvFixture('native/projected-rows.csv');
    expect(parser.writeCountWhereAll(input, [], true)).toBe(3);
  });

  test('rejects invalid multiple-filter options', () => {
    expect(() => normalizeNativeFilters([{ column: 0, values: [] }])).toThrow('filter values must not be empty');
    expect(() => normalizeNativeFilters(Array.from({ length: 2025 }, () => ({ column: 0, value: 'x' })))).toThrow(
      'filter count out of range: 2025',
    );

    using parser = new NativeCsvParser();
    expect(() =>
      parser.writeProjectedBatch(Buffer.from('x\n'), {
        equalsFilter: { column: 0, value: 'x' },
        filters: [],
      })
    ).toThrow('use equalsFilter or filters, not both');
  });
});
