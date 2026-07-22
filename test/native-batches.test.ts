import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  NativeCsvParser,
  NativeCsvRowView,
  parseCsvBuffer,
} from '../src/index.ts';
import { readCsvFixture } from './fixtures.ts';

describe('NativeCsvParser batches and materialization', () => {
  test('exposes lazy field views and selected columns', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(readCsvFixture('native/quoted-semicolon-people.csv'), true);
    expect(batch.rowCount).toBe(2);
    expect(batch.rowOffsets()).toBeInstanceOf(BigUint64Array);
    expect(batch.fieldOffsets()).toBeInstanceOf(BigUint64Array);
    expect([...batch.rowOffsets()]).toEqual([0n, 3n, 6n]);
    expect(batch.rowFieldCount(0)).toBe(3);
    expect(batch.fieldString(1, 2)).toBe('RJ');
    expect(batch.fieldBuffer(0, 1)?.toString()).toBe('Ana');
    const dataView = batch.dataView();
    const fieldBytes = batch.fieldBytes(0, 1);
    expect(dataView).toBeInstanceOf(Uint8Array);
    expect(fieldBytes).toBeInstanceOf(Uint8Array);
    expect(fieldBytes?.buffer).toBe(dataView.buffer);
    expect(Buffer.from(fieldBytes ?? []).toString()).toBe('Ana');
    expect(batch.fieldBytes(0, 9)).toBeNull();
    const ranged: string[] = [];
    batch.forEachColumnRange(2, (_rowIndex, start, end) => {
      ranged.push(batch.data().toString('utf8', start, end));
    });
    expect(ranged).toEqual(['SP', 'RJ']);
    expect(batch.rowsInto([], [0, 2])).toEqual([
      ['1', 'SP'],
      ['2', 'RJ'],
    ]);
    expect(batch.countWhereEquals(2, 'SP')).toBe(1);
  });

  test('parses trusted fixed-column batches without quoted newlines', () => {
    using parser = new NativeCsvParser({
      delimiter: ';',
      trusted: { fixedColumns: 3, noNewlinesInQuotes: true },
    });
    const input = readCsvFixture('native/trusted-fixed-columns-mixed-newlines.csv');
    const rows: string[][] = [];
    {
      using batch = parser.writeBatch(input.subarray(0, 15));
      expect(batch.rows()).toEqual([]);
    }
    {
      using batch = parser.writeBatch(input.subarray(15));
      rows.push(...batch.rows());
    }
    {
      using batch = parser.endBatch();
      rows.push(...batch.rows());
    }

    expect(rows).toEqual([
      ['1', 'Ana; A', 'SP'],
      ['2', 'Joao "J"', 'RJ'],
    ]);
  });

  test('parses fixed-column batches with quoted newlines', () => {
    using parser = new NativeCsvParser({
      delimiter: ';',
      fixedColumns: 3,
    });
    const input = readCsvFixture('native/fixed-columns-quoted-newline.csv');
    const rows: string[][] = [];
    {
      using batch = parser.writeBatch(input.subarray(0, 14));
      expect(batch.rows()).toEqual([]);
    }
    {
      using batch = parser.writeBatch(input.subarray(14));
      rows.push(...batch.rows());
    }
    {
      using batch = parser.endBatch();
      rows.push(...batch.rows());
    }

    expect(rows).toEqual([
      ['1', 'Ana\nA', 'SP'],
      ['2', 'Joao', 'RJ'],
    ]);
  });

  test('fixed-column batches reject column count mismatch', () => {
    using parser = new NativeCsvParser({ delimiter: ';', fixedColumns: 3 });
    expect(() => parser.writeBatch(readCsvFixture('native/fixed-column-mismatch.csv'))).toThrow('fixed row column count mismatch');
  });

  test('trusted fixed-column batches decode latin1', () => {
    using parser = new NativeCsvParser({
      delimiter: ';',
      encoding: 'latin1',
      trusted: { fixedColumns: 2, noNewlinesInQuotes: true },
    });
    using batch = parser.writeBatch(readCsvFixture('native/latin1-one-name.csv'), true);
    expect(batch.rows()).toEqual([['1', 'João']]);
  });

  test('trusted fixed-column batches reject column count mismatch', () => {
    using parser = new NativeCsvParser({
      delimiter: ';',
      trusted: { fixedColumns: 3, noNewlinesInQuotes: true },
    });
    expect(() => parser.writeBatch(readCsvFixture('native/fixed-column-mismatch.csv'))).toThrow(
      'trusted fixed row column count mismatch',
    );
  });

  test('iterates rows with one reusable row view', () => {
    using parser = new NativeCsvParser({ delimiter: ';' });
    using batch = parser.writeBatch(readCsvFixture('native/quoted-semicolon-people.csv'), true);
    const seen: Array<{
      rowIndex: number;
      fieldCount: number;
      id: string | null;
      name: string | null;
      uf: string | null;
      missing: string | null;
      nameBytes: string | undefined;
      ufBuffer: string | undefined;
    }> = [];
    const rowViews = new Set<unknown>();

    batch.forEachRow((row, rowIndex) => {
      rowViews.add(row);
      seen.push({
        rowIndex,
        fieldCount: row.fieldCount,
        id: row.fieldString(0),
        name: row.fieldString(1),
        uf: row.fieldString(2),
        missing: row.fieldString(4),
        nameBytes: row.fieldBytes(1)?.toString(),
        ufBuffer: row.fieldBuffer(2)?.toString(),
      });
    });

    expect(rowViews.size).toBe(1);
    expect(seen).toEqual([
      {
        rowIndex: 0,
        fieldCount: 3,
        id: '1',
        name: 'Ana',
        uf: 'SP',
        missing: null,
        nameBytes: 'Ana',
        ufBuffer: 'SP',
      },
      {
        rowIndex: 1,
        fieldCount: 3,
        id: '2',
        name: 'Joao',
        uf: 'RJ',
        missing: null,
        nameBytes: 'Joao',
        ufBuffer: 'RJ',
      },
    ]);
  });

  test('parseCsvBuffer materializes selected columns', () => {
    expect(parseCsvBuffer(readCsvFixture('native/quoted-semicolon-one-person-with-header.csv'), {
      delimiter: ';',
      selectedColumns: [0, 2],
    })).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
    ]);
  });

  test('rejects offsets that cannot be represented safely or exceed backing storage', () => {
    const unsafe = new NativeCsvRowView(
      Buffer.alloc(0),
      new BigUint64Array([0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]),
      new BigUint64Array([0n]),
    );
    expect(() => unsafe.fieldCount).toThrow('exceeds Number.MAX_SAFE_INTEGER');

    const outsideData = new NativeCsvRowView(
      Buffer.from('a'),
      new BigUint64Array([0n, 1n]),
      new BigUint64Array([0n, 2n]),
    );
    expect(() => outsideData.fieldRange(0)).toThrow('exceeds backing storage');
  });
});
