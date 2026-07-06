import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  parseChunkedRows,
  parseRows,
} from './helpers.ts';

const quoteSyntaxCases = [
  {
    name: 'missing-closing-quote',
    csv: 'id,name\n1,"Ada',
    error: 'unterminated quoted field',
  },
  {
    name: 'unescaped-quote-inside-quoted-field',
    csv: 'id,name\n1,"Ad"a',
    error: 'unescaped quote in quoted field',
  },
  {
    name: 'unescaped-quote-in-unquoted-field',
    csv: 'id,name\n1,Ad"a',
    error: 'unescaped quote in unquoted field',
  },
] as const;

describe('strict RFC 4180 quote syntax validation', () => {
  for (const fixture of quoteSyntaxCases) {
    test(`strict mode rejects ${fixture.name}`, () => {
      expect(() => parseRows(fixture.csv, { strict: true })).toThrow(fixture.error);
    });

    for (const chunkSize of [1, 3, 64]) {
      test(`strict mode rejects ${fixture.name} with ${chunkSize}-byte chunks`, () => {
        expect(() => parseChunkedRows(fixture.csv, chunkSize, { strict: true })).toThrow(fixture.error);
      });
    }

    test(`default mode keeps permissive behavior for ${fixture.name}`, () => {
      expect(() => parseRows(fixture.csv)).not.toThrow();
    });
  }

  test('strict mode accepts closing quote at EOF', () => {
    expect(parseRows('id,name\n1,"Ada"', { strict: true })).toEqual([
      ['id', 'name'],
      ['1', 'Ada'],
    ]);
  });

  test('strict fixedColumns keeps fixed-column checks', () => {
    expect(() => parseRows('1,2\n', { fixedColumns: 3, strict: true })).toThrow('fixed row column count mismatch');
    expect(() => parseRows('1,Ad"a,3\n', { fixedColumns: 3, strict: true })).toThrow(
      'unescaped quote in unquoted field',
    );
  });

  test('strict trusted fixedColumns keeps trusted fixed-column path checks', () => {
    const trusted = { fixedColumns: 3, noNewlinesInQuotes: true } as const;

    expect(parseRows('1,"Ada",SP\n', { trusted, strict: true })).toEqual([['1', 'Ada', 'SP']]);
    expect(() => parseRows('1,2\n', { trusted, strict: true })).toThrow(
      'trusted fixed row column count mismatch',
    );
    expect(() => parseRows('1,Ad"a,3\n', { trusted, strict: true })).toThrow(
      'unescaped quote in unquoted field',
    );
  });

  test.todo('strict RFC 4180 mode rejects header-too-few-fields', () => {});
  test.todo('strict RFC 4180 mode rejects header-too-many-fields', () => {});
  test.todo('strict RFC 4180 mode rejects header-missing-row', () => {});
  test.todo('strict RFC 4180 mode rejects header-name-mismatch', () => {});
});
