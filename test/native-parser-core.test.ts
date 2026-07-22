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

describe('NativeCsvParser core parsing', () => {
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
    const input = Buffer.from('"h";"v"\r\n"1";"a""b\nc"\r\nplain"quote;z\r"tail";"x"');
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
    expect(parseCsvBuffer(Buffer.from('\n\n'))).toEqual([[''], ['']]);
    expect(parseCsvBuffer(Buffer.from('a\n\n'))).toEqual([['a'], ['']]);

    const parser = new NativeCsvParser();
    try {
      let count = 0;
      count += parser.writeCount(Buffer.from('\n\n'));
      count += parser.endCount();
      expect(count).toBe(2);
    } finally {
      parser.close();
    }
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
});
