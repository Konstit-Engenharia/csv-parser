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
