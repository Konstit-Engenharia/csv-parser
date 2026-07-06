import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  CsvStringCache,
  NativeCsvParser,
  parseCsvBuffer,
} from '../src/index.ts';

describe('NativeCsvParser batches and materialization', () => {
  test('exposes lazy field views and selected columns', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      const batch = parser.writeBatch(Buffer.from('"1";"Ana";"SP"\n"2";"Joao";"RJ"\n'), true);
      try {
        expect(batch.rowCount).toBe(2);
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
      } finally {
        batch.close();
      }
    } finally {
      parser.close();
    }
  });

  test('parses trusted fixed-column batches without quoted newlines', () => {
    const parser = new NativeCsvParser({
      delimiter: ';',
      trusted: { fixedColumns: 3, noNewlinesInQuotes: true },
    });
    try {
      const rows: string[][] = [];
      let batch = parser.writeBatch(Buffer.from('"1";"Ana; A";"S'));
      try {
        expect(batch.rows()).toEqual([]);
      } finally {
        batch.close();
      }

      batch = parser.writeBatch(Buffer.from('P"\r\n"2";"Joao ""J""";"RJ"\n'));
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      batch = parser.endBatch();
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      expect(rows).toEqual([
        ['1', 'Ana; A', 'SP'],
        ['2', 'Joao "J"', 'RJ'],
      ]);
    } finally {
      parser.close();
    }
  });

  test('parses fixed-column batches with quoted newlines', () => {
    const parser = new NativeCsvParser({
      delimiter: ';',
      fixedColumns: 3,
    });
    try {
      const rows: string[][] = [];
      let batch = parser.writeBatch(Buffer.from('"1";"Ana\nA";"S'));
      try {
        expect(batch.rows()).toEqual([]);
      } finally {
        batch.close();
      }

      batch = parser.writeBatch(Buffer.from('P"\n"2";"Joao";"RJ"\n'));
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      batch = parser.endBatch();
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      expect(rows).toEqual([
        ['1', 'Ana\nA', 'SP'],
        ['2', 'Joao', 'RJ'],
      ]);
    } finally {
      parser.close();
    }
  });

  test('fixed-column batches reject column count mismatch', () => {
    const parser = new NativeCsvParser({ delimiter: ';', fixedColumns: 3 });
    try {
      expect(() => parser.writeBatch(Buffer.from('1;2\n'))).toThrow('fixed row column count mismatch');
    } finally {
      parser.close();
    }
  });

  test('trusted fixed-column batches decode latin1', () => {
    const parser = new NativeCsvParser({
      delimiter: ';',
      encoding: 'latin1',
      trusted: { fixedColumns: 2, noNewlinesInQuotes: true },
    });
    try {
      const batch = parser.writeBatch(
        new Uint8Array([
          0x31,
          0x3b,
          0x4a,
          0x6f,
          0xe3,
          0x6f,
          0x0a,
        ]),
        true,
      );
      try {
        expect(batch.rows()).toEqual([['1', 'João']]);
      } finally {
        batch.close();
      }
    } finally {
      parser.close();
    }
  });

  test('trusted fixed-column batches reject column count mismatch', () => {
    const parser = new NativeCsvParser({
      delimiter: ';',
      trusted: { fixedColumns: 3, noNewlinesInQuotes: true },
    });
    try {
      expect(() => parser.writeBatch(Buffer.from('1;2\n'))).toThrow('trusted fixed row column count mismatch');
    } finally {
      parser.close();
    }
  });

  test('iterates rows with one reusable row view', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      const batch = parser.writeBatch(Buffer.from('"1";"Ana";"SP"\n"2";"Joao";"RJ"\n'), true);
      try {
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
      } finally {
        batch.close();
      }
    } finally {
      parser.close();
    }
  });

  test('can reuse decoded strings for selected low-cardinality columns', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    const cache = new CsvStringCache({ columns: [2] });
    try {
      const batch = parser.writeBatch(Buffer.from('"1";"Ana";"SP"\n"2";"Joao";"SP"\n"3";"Bia";"RJ"\n'), true);
      try {
        expect(batch.rowsInto([], [0, 2], cache)).toEqual([
          ['1', 'SP'],
          ['2', 'SP'],
          ['3', 'RJ'],
        ]);
        expect(cache.stats()).toEqual([{
          column: 2,
          entries: 2,
          hits: 1,
          misses: 2,
          full: false,
        }]);
      } finally {
        batch.close();
      }
    } finally {
      parser.close();
    }
  });

  test('parseCsvBuffer materializes selected columns', () => {
    expect(parseCsvBuffer(Buffer.from('"id";"name";"uf"\n"1";"Ana";"SP"\n'), {
      delimiter: ';',
      selectedColumns: [0, 2],
    })).toEqual([
      ['id', 'uf'],
      ['1', 'SP'],
    ]);
  });
});
