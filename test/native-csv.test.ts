import {
  describe,
  expect,
  test,
} from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  countCsvFileWhereEquals,
  countCsvFileWhereIn,
  countCsvFileWhereStartsWith,
  countTrustedNewlineRows,
  type CsvGroupByCountEntry,
  CsvStringCache,
  NativeCsvParser,
  parseCsvBuffer,
  parseCsvFileColumnStats,
  parseCsvFileDictionary,
  parseCsvFileGroupByCount,
  parseCsvFileMultiColumnStats,
} from '../src/index.ts';

describe('NativeCsvParser', () => {
  test('parses utf8 csv with quotes across chunks', () => {
    const parser = new NativeCsvParser();
    try {
      expect(parser.write(Buffer.from('name,city\n"ana'))).toEqual([['name', 'city']]);
      expect(parser.write(Buffer.from(' ""a""",sao\njoao,"rio\nsul"'), true)).toEqual([
        ['ana "a"', 'sao'],
        ['joao', 'rio\nsul'],
      ]);
    } finally {
      parser.close();
    }
  });

  test('decodes latin1 to utf8', () => {
    const input = new Uint8Array([
      0x6e,
      0x6f,
      0x6d,
      0x65,
      0x0a,
      0x4a,
      0x6f,
      0xe3,
      0x6f,
      0x0a,
      0x4d,
      0xe1,
      0x72,
      0x63,
      0x69,
      0x61,
    ]);
    expect(parseCsvBuffer(input, { encoding: 'latin1' })).toEqual([['nome'], ['João'], ['Márcia']]);
  });

  test('counts rows without materializing fields', () => {
    const parser = new NativeCsvParser({ encoding: 'latin1' });
    try {
      let count = 0;
      count += parser.writeCount(Buffer.from('a,b\n1,2\n'));
      count += parser.writeCount(Buffer.from('"3\nx",4'), true);
      expect(count).toBe(3);
    } finally {
      parser.close();
    }
  });

  test('counts trusted newline-delimited rows without CSV quote parsing', () => {
    expect(countTrustedNewlineRows(Buffer.from('a,b\n1,2\n3,4'))).toBe(3);
    expect(countTrustedNewlineRows(Buffer.from('a,b\r\n1,2\r\n'))).toBe(2);
    expect(countTrustedNewlineRows(Buffer.alloc(0))).toBe(0);
  });

  test('does not emit an extra row when stream ends after newline', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      expect(parser.write(Buffer.from('"a";"b"\n'))).toEqual([['a', 'b']]);
      expect(parser.end()).toEqual([]);
    } finally {
      parser.close();
    }
  });

  test('matches csv-parser style semicolon multiline rows', () => {
    const input = Buffer.from('"1";"HARMON LIDICE\n";"MG"\n"2";"OK";"SP"\n');
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      let count = 0;
      count += parser.writeCount(input);
      count += parser.endCount();
      expect(count).toBe(2);
      expect(parseCsvBuffer(input, { delimiter: ';' })).toEqual([
        ['1', 'HARMON LIDICE\n', 'MG'],
        ['2', 'OK', 'SP'],
      ]);
    } finally {
      parser.close();
    }
  });

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

  test('encodes one selected column as native dictionary ids', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      const batch = parser.writeDictionaryBatch(Buffer.from('"1";"SP"\n"2";"SP"\n"3";"RJ"\n'), 1, true);
      try {
        expect([...batch.ids()]).toEqual([0, 0, 1]);
        expect(batch.dictionaryStrings()).toEqual(['SP', 'RJ']);
      } finally {
        batch.close();
      }
    } finally {
      parser.close();
    }
  });

  test('counts one selected column as native groupBy dictionary', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      expect(parser.writeGroupByCount(Buffer.from('"1";"SP"\n"2";"'), 1)).toBe(1);
      expect(parser.writeGroupByCount(Buffer.from('SP"\n"3";"RJ"\n"4"\n'), 1)).toBe(3);
      const batch = parser.endGroupByCount(1);
      try {
        expect(batch.rowCount).toBe(4);
        expect(batch.dictionaryStrings()).toEqual(['SP', 'RJ', '']);
        expect(batch.countsNumbers()).toEqual([2, 1, 1]);
        expect(batch.entries()).toEqual([
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
          { value: '', count: 1 },
        ]);
      } finally {
        batch.close();
      }
    } finally {
      parser.close();
    }
  });

  test('collects selected column ids and counts in one native pass', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      expect(parser.writeColumnStats(Buffer.from('"1";"SP"\n"2";"'), 1)).toBe(1);
      expect(parser.writeColumnStats(Buffer.from('SP"\n"3";"RJ"\n"4"\n'), 1)).toBe(3);
      const batch = parser.endColumnStats(1);
      try {
        expect(batch.rowCount).toBe(4);
        expect(batch.dictionaryStrings()).toEqual(['SP', 'RJ', '']);
        expect(batch.dictionaryString(1)).toBe('RJ');
        expect([...batch.ids()]).toEqual([0, 0, 1, 2]);
        expect(batch.countsNumbers()).toEqual([2, 1, 1]);
        expect(batch.countNumberAt(0)).toBe(2);
        expect(batch.entries()).toEqual([
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
          { value: '', count: 1 },
        ]);
        const entries: CsvGroupByCountEntry[] = [];
        batch.forEachEntry((value, count) => {
          entries.push({ value, count });
        });
        expect(entries).toEqual([
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
          { value: '', count: 1 },
        ]);
        expect(batch.dictionaryDataView().byteLength).toBe(batch.dictionaryData().byteLength);
      } finally {
        batch.close();
      }
    } finally {
      parser.close();
    }
  });

  test('collects multiple selected column stats in one native pass', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      expect(parser.writeMultiColumnStats(Buffer.from('"id";"uf";"kind"\n"1";"'), [0, 1, 2])).toBe(1);
      expect(parser.writeMultiColumnStats(Buffer.from('SP";"A"\n"2";"SP";"B"\n"3";"RJ";"A"\n"4"\n'), [0, 1, 2])).toBe(4);
      const batches = parser.endMultiColumnStats([0, 1, 2]);
      try {
        const idBatch = batches[0];
        const ufBatch = batches[1];
        const kindBatch = batches[2];
        if (idBatch === undefined || ufBatch === undefined || kindBatch === undefined) {
          throw new Error('expected three multi-column stats batches');
        }
        expect(batches.map((batch) => batch.column)).toEqual([0, 1, 2]);
        expect(batches.map((batch) => batch.rowCount)).toEqual([5, 5, 5]);
        expect([...idBatch.ids()]).toEqual([0, 1, 2, 3, 4]);
        expect(idBatch.entries()).toEqual([
          { value: 'id', count: 1 },
          { value: '1', count: 1 },
          { value: '2', count: 1 },
          { value: '3', count: 1 },
          { value: '4', count: 1 },
        ]);
        expect([...ufBatch.ids()]).toEqual([0, 1, 1, 2, 3]);
        expect(ufBatch.entries()).toEqual([
          { value: 'uf', count: 1 },
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
          { value: '', count: 1 },
        ]);
        expect([...kindBatch.ids()]).toEqual([0, 1, 2, 1, 3]);
        expect(kindBatch.entries()).toEqual([
          { value: 'kind', count: 1 },
          { value: 'A', count: 2 },
          { value: 'B', count: 1 },
          { value: '', count: 1 },
        ]);
      } finally {
        for (const batch of batches) {
          batch.close();
        }
      }
    } finally {
      parser.close();
    }
  });

  test('rejects repeated multi-column stats columns', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      expect(() => parser.writeMultiColumnStats(Buffer.from('"id";"uf"\n'), [1, 1])).toThrow(
        'multi-column stats column repeated: 1',
      );
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

  test('projects and filters inside native parser', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    const rows: string[][] = [];
    const options = {
      selectedColumns: [2, 0],
      equalsFilter: { column: 2, value: 'SP' },
    };

    try {
      let batch = parser.writeProjectedBatch(Buffer.from('"id";"name";"uf"\n"1";'), options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      batch = parser.writeProjectedBatch(Buffer.from('"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"SP"\n'), options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      batch = parser.endProjectedBatch(options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      expect(rows).toEqual([
        ['SP', '1'],
        ['SP', '3'],
      ]);
    } finally {
      parser.close();
    }
  });

  test('countCsvFileWhereEquals filters natively by column bytes', async () => {
    const path = join(import.meta.dir, 'tmp-filter.csv');
    await Bun.write(path, '"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"SP"\n');
    try {
      expect(await countCsvFileWhereEquals(path, 2, 'SP', { delimiter: ';' })).toBe(2);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('countCsvFileWhereIn filters natively by a set of byte values', async () => {
    const path = join(import.meta.dir, 'tmp-filter-in.csv');
    await Bun.write(
      path,
      '"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"MG"\n"4";"Lia";"SP"\n',
    );
    try {
      expect(await countCsvFileWhereIn(path, 2, ['SP', 'RJ'], { delimiter: ';', chunkSize: 11 })).toBe(3);
      expect(await countCsvFileWhereIn(path, 2, [Buffer.from('MG')], { delimiter: ';', chunkSize: 7 })).toBe(1);
      expect(await countCsvFileWhereIn(path, 2, [], { delimiter: ';' })).toBe(0);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('countCsvFileWhereStartsWith filters natively by prefix bytes', async () => {
    const path = join(import.meta.dir, 'tmp-filter-prefix.csv');
    await Bun.write(
      path,
      '"id";"name";"city"\n"1";"Ana";"Sao Paulo"\n"2";"Joao";"Rio"\n"3";"Bia";"Santos"\n',
    );
    try {
      expect(await countCsvFileWhereStartsWith(path, 2, 'Sa', { delimiter: ';', chunkSize: 13 })).toBe(2);
      expect(await countCsvFileWhereStartsWith(path, 2, Buffer.from('Rio'), { delimiter: ';', chunkSize: 9 })).toBe(1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('NativeCsvParser streams in and startsWith native filters across chunks', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      let count = 0;
      count += parser.writeCountWhereIn(Buffer.from('"id";"uf"\n"1";"S'), { column: 1, values: ['SP', 'RJ'] });
      count += parser.writeCountWhereIn(Buffer.from('P"\n"2";"RJ"\n"3";"MG"\n'), { column: 1, values: ['SP', 'RJ'] });
      count += parser.endCountWhereIn({ column: 1, values: ['SP', 'RJ'] });
      expect(count).toBe(2);
    } finally {
      parser.close();
    }

    const startsWithParser = new NativeCsvParser({ delimiter: ';' });
    try {
      let count = 0;
      count += startsWithParser.writeCountWhereStartsWith(Buffer.from('"id";"city"\n"1";"Sa'), {
        column: 1,
        prefix: 'Sa',
      });
      count += startsWithParser.writeCountWhereStartsWith(Buffer.from('ntos"\n"2";"Rio"\n'), {
        column: 1,
        prefix: 'Sa',
      });
      count += startsWithParser.endCountWhereStartsWith({ column: 1, prefix: 'Sa' });
      expect(count).toBe(1);
    } finally {
      startsWithParser.close();
    }
  });

  test('streams native dictionary batches from a file', async () => {
    const path = join(import.meta.dir, 'tmp-dictionary.csv');
    await Bun.write(path, '"id";"uf"\n"1";"SP"\n"2";"SP"\n"3";"RJ"\n');
    try {
      const dictionaries: string[][] = [];
      let rows = 0;
      for await (const batch of parseCsvFileDictionary(path, 1, { delimiter: ';', chunkSize: 12 })) {
        try {
          rows += batch.rowCount;
          dictionaries.push(batch.dictionaryStrings());
        } finally {
          batch.close();
        }
      }
      expect(rows).toBe(4);
      expect(dictionaries.flat()).toContain('SP');
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('streams native groupBy count from a file', async () => {
    const path = join(import.meta.dir, 'tmp-groupby-count.csv');
    await Bun.write(path, '"id";"uf"\n"1";"SP"\n"2";"SP"\n"3";"RJ"\n');
    try {
      const batch = await parseCsvFileGroupByCount(path, 1, { delimiter: ';', chunkSize: 12 });
      try {
        expect(batch.rowCount).toBe(4);
        expect(batch.entries()).toEqual([
          { value: 'uf', count: 1 },
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
        ]);
      } finally {
        batch.close();
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('streams native column stats from a file', async () => {
    const path = join(import.meta.dir, 'tmp-column-stats.csv');
    await Bun.write(path, '"id";"uf"\n"1";"SP"\n"2";"SP"\n"3";"RJ"\n');
    try {
      const batch = await parseCsvFileColumnStats(path, 1, { delimiter: ';', chunkSize: 12 });
      try {
        expect(batch.rowCount).toBe(4);
        expect([...batch.ids()]).toEqual([0, 1, 1, 2]);
        expect(batch.entries()).toEqual([
          { value: 'uf', count: 1 },
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
        ]);
      } finally {
        batch.close();
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('streams native multi-column stats from a file', async () => {
    const path = join(import.meta.dir, 'tmp-multi-column-stats.csv');
    await Bun.write(path, '"id";"uf";"kind"\n"1";"SP";"A"\n"2";"SP";"B"\n"3";"RJ";"A"\n');
    try {
      const batches = await parseCsvFileMultiColumnStats(path, [1, 2], { delimiter: ';', chunkSize: 12 });
      try {
        const ufBatch = batches[0];
        const kindBatch = batches[1];
        if (ufBatch === undefined || kindBatch === undefined) {
          throw new Error('expected two multi-column stats batches');
        }
        expect(batches.map((batch) => batch.column)).toEqual([1, 2]);
        expect(ufBatch.entries()).toEqual([
          { value: 'uf', count: 1 },
          { value: 'SP', count: 2 },
          { value: 'RJ', count: 1 },
        ]);
        expect(kindBatch.entries()).toEqual([
          { value: 'kind', count: 1 },
          { value: 'A', count: 2 },
          { value: 'B', count: 1 },
        ]);
      } finally {
        for (const batch of batches) {
          batch.close();
        }
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('returns empty native column stats for an empty file', async () => {
    const path = join(import.meta.dir, 'tmp-column-stats-empty.csv');
    await Bun.write(path, '');
    try {
      const batch = await parseCsvFileColumnStats(path, 1, { delimiter: ';', chunkSize: 12 });
      try {
        expect(batch.rowCount).toBe(0);
        expect([...batch.ids()]).toEqual([]);
        expect(batch.entries()).toEqual([]);
      } finally {
        batch.close();
      }
    } finally {
      rmSync(path, { force: true });
    }
  });
});
