import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  createNativeCsvColumnStatsBatch,
  createNativeCsvGroupByCountBatch,
} from '../src/batches.ts';
import {
  type CsvGroupByCountEntry,
  NativeCsvParser,
} from '../src/index.ts';

describe('NativeCsvParser native aggregates', () => {
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

  test('rebuilds native groupBy count batch from merged parts', () => {
    const batch = createNativeCsvGroupByCountBatch({
      counts: [2n, 1n, 1n],
      dictionaryData: Buffer.from('SPRJ'),
      dictionaryOffsets: [0, 2, 4, 4],
      rowCount: 4,
    });
    try {
      expect(batch.rowCount).toBe(4);
      expect(batch.dictionaryStrings()).toEqual(['SP', 'RJ', '']);
      expect(batch.countsNumbers()).toEqual([2, 1, 1]);
    } finally {
      batch.close();
    }
  });

  test('rebuilds native column stats batch from merged parts', () => {
    const batch = createNativeCsvColumnStatsBatch({
      column: 1,
      counts: [2n, 1n, 1n],
      dictionaryData: Buffer.from('SPRJ'),
      dictionaryOffsets: [0, 2, 4, 4],
      ids: [0, 0, 1, 2],
    });
    try {
      expect(batch.column).toBe(1);
      expect([...batch.ids()]).toEqual([0, 0, 1, 2]);
      expect(batch.entries()).toEqual([
        { value: 'SP', count: 2 },
        { value: 'RJ', count: 1 },
        { value: '', count: 1 },
      ]);
    } finally {
      batch.close();
    }
  });
});
