import {
  describe,
  expect,
  test,
} from 'bun:test';
import { NativeCsvParser } from '../src/index.ts';
import { readCsvFixture } from './fixtures.ts';

describe('native resource lifecycle', () => {
  test('parser and row batches expose dispose state and use-after-close errors', () => {
    const parser = new NativeCsvParser();
    expect(parser.closed).toBe(false);

    const batch = parser.writeBatch(readCsvFixture('native/unquoted-comma-two-rows.csv'), true);
    expect(batch.closed).toBe(false);
    expect(batch.rows()).toEqual([['a', 'b'], ['1', '2']]);

    batch.dispose();
    expect(batch.closed).toBe(true);
    expect(() => batch.rows()).toThrow('native CSV batch is closed');
    batch.close();
    expect(batch.closed).toBe(true);

    parser.dispose();
    expect(parser.closed).toBe(true);
    expect(() => parser.write(readCsvFixture('native/single-x.csv'))).toThrow('native CSV parser is closed');
    parser.close();
    expect(parser.closed).toBe(true);
  });

  test('Bun using closes parser and row batches', () => {
    let parserRef: NativeCsvParser | undefined;
    let batchRef: ReturnType<NativeCsvParser['writeBatch']> | undefined;

    {
      using parser = new NativeCsvParser();
      parserRef = parser;
      {
        using batch = parser.writeBatch(readCsvFixture('native/unquoted-comma-two-rows.csv'), true);
        batchRef = batch;
        expect(batch.closed).toBe(false);
        expect(batch.rows()).toEqual([['a', 'b'], ['1', '2']]);
      }
      expect(batchRef.closed).toBe(true);
      expect(parser.closed).toBe(false);
    }

    expect(parserRef.closed).toBe(true);
    expect(batchRef.closed).toBe(true);
  });
});
