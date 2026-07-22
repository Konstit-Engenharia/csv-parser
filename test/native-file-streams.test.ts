import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  csv,
  findCsvSafeShards,
  findCsvSafeSplitOffsets,
} from '../src/index.ts';
import { csvFixturePath } from './fixtures.ts';

describe('NativeCsvParser file streams', () => {
  test('finds csv-safe split offsets and shards through TS API', async () => {
    const path = csvFixturePath('native/safe-split-multiline.csv');
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
  });

  test('keeps CRLF and quoted newlines intact at exact split offsets', async () => {
    const crlfPath = csvFixturePath('native/safe-split-crlf.csv');
    const escapedPath = csvFixturePath('native/safe-split-escaped-quote.csv');
    expect(findCsvSafeSplitOffsets(crlfPath, 2, { delimiter: ';' })).toEqual([0, 15, 20]);
    expect(findCsvSafeSplitOffsets(crlfPath, 4, { delimiter: ';' })).toEqual([0, 5, 15, 20]);
    expect(findCsvSafeSplitOffsets(escapedPath, 2, { delimiter: ';' })).toEqual([0, 12, 18]);
  });
});
