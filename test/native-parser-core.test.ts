import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  countTrustedNewlineRows,
  NativeCsvParser,
  parseCsvBuffer,
} from '../src/index.ts';
import { readCsvFixture } from './fixtures.ts';

describe('NativeCsvParser core parsing', () => {
  test('parses utf8 csv with quotes across chunks', () => {
    const parser = new NativeCsvParser();
    try {
      const input = readCsvFixture('native/utf8-quotes-across-chunks.csv');
      expect(parser.write(input.subarray(0, 14))).toEqual([['name', 'city']]);
      expect(parser.write(input.subarray(14), true)).toEqual([
        ['ana "a"', 'sao'],
        ['joao', 'rio\nsul'],
      ]);
    } finally {
      parser.close();
    }
  });

  test('decodes latin1 to utf8', () => {
    const input = readCsvFixture('native/latin1-name-column.csv');
    expect(parseCsvBuffer(input, { encoding: 'latin1' })).toEqual([['nome'], ['João'], ['Márcia']]);
  });

  test('counts rows without materializing fields', () => {
    const parser = new NativeCsvParser({ encoding: 'latin1' });
    try {
      const input = readCsvFixture('native/comma-multiline-count.csv');
      let count = 0;
      count += parser.writeCount(input.subarray(0, 8));
      count += parser.writeCount(input.subarray(8), true);
      expect(count).toBe(3);
    } finally {
      parser.close();
    }
  });

  test('counts trusted newline-delimited rows without CSV quote parsing', () => {
    expect(countTrustedNewlineRows(readCsvFixture('native/trusted-lf-rows.csv'))).toBe(3);
    expect(countTrustedNewlineRows(readCsvFixture('native/trusted-crlf-rows.csv'))).toBe(2);
    expect(countTrustedNewlineRows(Buffer.alloc(0))).toBe(0);
  });

  test('counts trusted newlines across SIMD boundaries and typed-array views', () => {
    const newlineOffsets = [0, 15, 16, 31, 32, 63, 64, 127];
    const backing = Buffer.alloc(134, 'x');
    const input = backing.subarray(2, 132);
    backing[1] = 0x0a;
    backing[132] = 0x0a;
    for (const offset of newlineOffsets) {
      input[offset] = 0x0a;
    }

    expect(countTrustedNewlineRows(input)).toBe(newlineOffsets.length + 1);
    expect(countTrustedNewlineRows(new Uint8Array(input.buffer, input.byteOffset, input.byteLength))).toBe(
      newlineOffsets.length + 1,
    );
  });

  test('counts quote-aware rows across every two-chunk split', () => {
    const input = readCsvFixture('native/quote-aware-row-count.csv');
    for (let split = 0; split <= input.length; ++split) {
      const parser = new NativeCsvParser({ delimiter: ';' });
      try {
        let rows = parser.writeCount(input.subarray(0, split));
        rows += parser.writeCount(input.subarray(split), true);
        expect(rows).toBe(4);
      } finally {
        parser.close();
      }
    }
  });

  test('counts structural events on both sides of SIMD boundaries', () => {
    for (const padding of [14, 15, 16, 30, 31, 32, 62, 63, 64]) {
      const input = Buffer.from(`${'a'.repeat(padding)};"x\ny";z\nnext;row;ok`);
      const parser = new NativeCsvParser({ delimiter: ';' });
      try {
        expect(parser.writeCount(input, true)).toBe(2);
      } finally {
        parser.close();
      }
    }
  });

  test('parses empty physical lines as empty records', () => {
    expect(parseCsvBuffer(readCsvFixture('native/empty-records.csv'))).toEqual([[''], ['']]);
    expect(parseCsvBuffer(readCsvFixture('native/one-value-and-empty-record.csv'))).toEqual([['a'], ['']]);

    const parser = new NativeCsvParser();
    try {
      let count = 0;
      count += parser.writeCount(readCsvFixture('native/empty-records.csv'));
      count += parser.endCount();
      expect(count).toBe(2);
    } finally {
      parser.close();
    }
  });

  test('does not emit an extra row when stream ends after newline', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      expect(parser.write(readCsvFixture('native/quoted-semicolon-one-row.csv'))).toEqual([['a', 'b']]);
      expect(parser.end()).toEqual([]);
    } finally {
      parser.close();
    }
  });
});
