import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  NativeCsvParser,
  parseCsvBuffer,
} from '../../src/index.ts';
import { readCsvFixture } from '../fixtures.ts';

describe('csv-parser compatibility', () => {
  test('matches semicolon multiline rows', () => {
    const input = readCsvFixture('native/semicolon-multiline-compatibility.csv');
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
});
