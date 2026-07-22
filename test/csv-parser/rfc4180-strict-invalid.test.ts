import {
  describe,
  expect,
  test,
} from 'bun:test';
import { readCsvFixture } from '../fixtures.ts';
import {
  parseChunkedRows,
  parseRows,
} from './helpers.ts';

const quoteSyntaxCases = [
  {
    name: 'missing-closing-quote',
    csv: readCsvFixture('rfc4180-invalid/missing-closing-quote.csv'),
    error: 'unterminated quoted field',
  },
  {
    name: 'unescaped-quote-inside-quoted-field',
    csv: readCsvFixture('rfc4180-invalid/unescaped-quote-inside-quoted-field.csv'),
    error: 'unescaped quote in quoted field',
  },
  {
    name: 'unescaped-quote-in-unquoted-field',
    csv: readCsvFixture('rfc4180-invalid/unescaped-quote-in-unquoted-field.csv'),
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
    expect(parseRows(readCsvFixture('rfc4180-invalid/closing-quote-at-eof.csv'), { strict: true })).toEqual([
      ['id', 'name'],
      ['1', 'Ada'],
    ]);
  });

  test('strict fixedColumns keeps fixed-column checks', () => {
    expect(() => parseRows(readCsvFixture('rfc4180-invalid/fixed-columns-too-few.csv'), { fixedColumns: 3, strict: true })).toThrow(
      'fixed row column count mismatch',
    );
    expect(() => parseRows(readCsvFixture('rfc4180-invalid/fixed-columns-unescaped-quote.csv'), { fixedColumns: 3, strict: true })).toThrow(
      'unescaped quote in unquoted field',
    );
  });

  test('strict trusted fixedColumns keeps trusted fixed-column path checks', () => {
    const trusted = { fixedColumns: 3, noNewlinesInQuotes: true } as const;

    expect(parseRows(readCsvFixture('rfc4180-invalid/trusted-fixed-columns-valid.csv'), { trusted, strict: true })).toEqual([[
      '1',
      'Ada',
      'SP',
    ]]);
    expect(() => parseRows(readCsvFixture('rfc4180-invalid/fixed-columns-too-few.csv'), { trusted, strict: true })).toThrow(
      'trusted fixed row column count mismatch',
    );
    expect(() => parseRows(readCsvFixture('rfc4180-invalid/fixed-columns-unescaped-quote.csv'), { trusted, strict: true })).toThrow(
      'unescaped quote in unquoted field',
    );
  });

  const columnCountCases = [
    {
      name: 'header-too-few-fields',
      csv: readCsvFixture('rfc4180-invalid/header-too-few-fields.csv'),
    },
    {
      name: 'header-too-many-fields',
      csv: readCsvFixture('rfc4180-invalid/header-too-many-fields.csv'),
    },
  ] as const;

  for (const fixture of columnCountCases) {
    test(`strict RFC 4180 mode rejects ${fixture.name}`, () => {
      expect(() => parseRows(fixture.csv, { strict: true })).toThrow('strict CSV row column count mismatch');
    });

    for (const chunkSize of [1, 3, 64]) {
      test(`strict RFC 4180 mode rejects ${fixture.name} with ${chunkSize}-byte chunks`, () => {
        expect(() => parseChunkedRows(fixture.csv, chunkSize, { strict: true })).toThrow(
          'strict CSV row column count mismatch',
        );
      });
    }
  }

  test('strict RFC 4180 mode rejects header-missing-row with schema metadata', () => {
    expect(() =>
      parseRows(readCsvFixture('rfc4180-invalid/header-missing-data-row.csv'), {
        expectedHeaders: ['id', 'name'],
        minDataRows: 1,
        strict: true,
      })
    ).toThrow('strict CSV schema error: expected at least 1 data row(s), got 0');
  });

  test('strict RFC 4180 mode rejects header-name-mismatch with schema metadata', () => {
    expect(() =>
      parseRows(readCsvFixture('rfc4180-invalid/header-name-mismatch.csv'), {
        expectedHeaders: ['id', 'name'],
        strict: true,
      })
    ).toThrow('strict CSV schema error: header mismatch at column 1');
  });

  test('strict RFC 4180 mode rejects missing header with schema metadata', () => {
    expect(() =>
      parseRows(readCsvFixture('empty.csv'), {
        expectedHeaders: ['id', 'name'],
        strict: true,
      })
    ).toThrow('strict CSV schema error: missing header row');
  });
});
