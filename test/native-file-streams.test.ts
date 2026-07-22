import {
  describe,
  expect,
  test,
} from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  csv,
  findCsvSafeShards,
  findCsvSafeSplitOffsets,
  parseCsvFileColumnStats,
  parseCsvFileDictionary,
  parseCsvFileGroupByCount,
  parseCsvFileMultiColumnStats,
} from '../src/index.ts';

describe('NativeCsvParser file streams', () => {
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

  test('finds csv-safe split offsets and shards through TS API', async () => {
    const path = join(import.meta.dir, 'tmp-split-offsets.csv');
    await Bun.write(path, 'id;name;notes\n1;ana;"um;dois"\n2;bob;"linha\ninterna"\n3;cai;ok\n4;dio;fim\n');
    try {
      const offsets = findCsvSafeSplitOffsets(path, 3, { delimiter: ';' });
      const shards = findCsvSafeShards(path, 3, { delimiter: ';' });
      const namespaceOffsets = csv.findCsvSafeSplitOffsets(path, 3, { delimiter: ';' });
      const namespaceShards = csv.findCsvSafeShards(path, 3, { delimiter: ';' });

      expect(offsets[0]).toBe(0);
      expect(offsets[offsets.length - 1]).toBe((await Bun.file(path).arrayBuffer()).byteLength);
      expect(offsets).toEqual(namespaceOffsets);
      expect(shards).toEqual(namespaceShards);
      expect(shards.length).toBeGreaterThan(0);
      for (const shard of shards) {
        expect(shard.end).toBeGreaterThanOrEqual(shard.start);
      }
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('keeps CRLF and quoted newlines intact at exact split offsets', async () => {
    const crlfPath = join(import.meta.dir, 'tmp-split-crlf.csv');
    const escapedPath = join(import.meta.dir, 'tmp-split-escaped.csv');
    await Bun.write(crlfPath, 'a;b\r\n1;"x\r\ny"\r\n2;z\r\n');
    await Bun.write(escapedPath, 'a;"b""\nc";d\nx;y;z\n');
    try {
      expect(findCsvSafeSplitOffsets(crlfPath, 2, { delimiter: ';' })).toEqual([0, 15, 20]);
      expect(findCsvSafeSplitOffsets(crlfPath, 4, { delimiter: ';' })).toEqual([0, 5, 15, 20]);
      expect(findCsvSafeSplitOffsets(escapedPath, 2, { delimiter: ';' })).toEqual([0, 12, 18]);
    } finally {
      rmSync(crlfPath, { force: true });
      rmSync(escapedPath, { force: true });
    }
  });
});
