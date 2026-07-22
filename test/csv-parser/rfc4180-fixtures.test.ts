import {
  describe,
  expect,
  test,
} from 'bun:test';
import { readCsvFixture } from '../fixtures.ts';
import {
  parseChunkedRows,
  parseRows,
  rowsToObjects,
} from './helpers.ts';

type ExpectedRows = string[][];
type ExpectedObjects = Array<Record<string, string>>;

interface Rfc4180Case {
  name: string;
  csv: Buffer;
  expected: ExpectedRows | ExpectedObjects;
  mode?: 'rows' | 'header';
}

// Corpus: project-owned RFC 4180 fixtures.
// Scope: valid parser fixtures with expected rows or header-object output.
const cases: Rfc4180Case[] = [
  {
    name: 'blank-records',
    csv: readCsvFixture('rfc4180/blank-records.csv'),
    expected: [[''], ['']],
  },
  {
    name: 'empty-field',
    csv: readCsvFixture('rfc4180/empty-field.csv'),
    expected: [['id', 'name', 'score'], ['7', '', '42']],
  },
  {
    name: 'empty-record-after-one-column-header',
    csv: readCsvFixture('rfc4180/empty-record-after-one-column-header.csv'),
    expected: [['token'], ['']],
  },
  {
    name: 'header-no-rows',
    csv: readCsvFixture('rfc4180/header-no-rows.csv'),
    expected: [],
    mode: 'header',
  },
  {
    name: 'header-simple',
    csv: readCsvFixture('rfc4180/header-simple.csv'),
    expected: [{ id: '7', name: 'Ada', total: '12' }],
    mode: 'header',
  },
  {
    name: 'leading-space',
    csv: readCsvFixture('rfc4180/leading-space.csv'),
    expected: [['id', 'label', 'value'], ['1', ' leading', '9']],
  },
  {
    name: 'one-column',
    csv: readCsvFixture('rfc4180/one-column.csv'),
    expected: [['token'], ['alpha']],
  },
  {
    name: 'quotes-empty',
    csv: readCsvFixture('rfc4180/quotes-empty.csv'),
    expected: [['id', 'label', 'value'], ['1', '', '9']],
  },
  {
    name: 'quotes-with-comma',
    csv: readCsvFixture('rfc4180/quotes-with-comma.csv'),
    expected: [['id', 'label', 'value'], ['1', 'north, east', '9']],
  },
  {
    name: 'quotes-with-escaped-quote',
    csv: readCsvFixture('rfc4180/quotes-with-escaped-quote.csv'),
    expected: [['id', 'label', 'value'], ['1', 'he said "go"', '9']],
  },
  {
    name: 'quotes-with-newline',
    csv: readCsvFixture('rfc4180/quotes-with-newline.csv'),
    expected: [['id', 'label', 'value'], ['1', 'line one\nline two', '9']],
  },
  {
    name: 'quotes-with-space',
    csv: readCsvFixture('rfc4180/quotes-with-space.csv'),
    expected: [['id', 'label', 'value'], ['1', 'field with spaces', '9']],
  },
  {
    name: 'simple-crlf',
    csv: readCsvFixture('rfc4180/simple-crlf.csv'),
    expected: [['id', 'name', 'total'], ['7', 'Ada', '12']],
  },
  {
    name: 'simple-lf',
    csv: readCsvFixture('rfc4180/simple-lf.csv'),
    expected: [['id', 'name', 'total'], ['7', 'Ada', '12']],
  },
  {
    name: 'trailing-newline-one-field',
    csv: readCsvFixture('rfc4180/trailing-newline-one-field.csv'),
    expected: [['token'], ['alpha']],
  },
  {
    name: 'trailing-newline',
    csv: readCsvFixture('rfc4180/trailing-newline.csv'),
    expected: [['id', 'name', 'total'], ['7', 'Ada', '12']],
  },
  {
    name: 'trailing-space',
    csv: readCsvFixture('rfc4180/trailing-space.csv'),
    expected: [['id', 'label', 'value'], ['1', 'trailing ', '9']],
  },
  {
    name: 'utf8',
    csv: readCsvFixture('rfc4180/utf8.csv'),
    expected: [['id', 'name', 'total'], ['7', 'café', '12']],
  },
];

describe('project-owned RFC 4180 fixtures', () => {
  for (const fixture of cases) {
    test(`${fixture.name} matches expected output`, () => {
      expect(parseExpected(fixture, parseRows(fixture.csv))).toEqual(fixture.expected);
    });

    for (const chunkSize of [1, 3, 64]) {
      test(`${fixture.name} matches expected output with ${chunkSize}-byte chunks`, () => {
        expect(parseExpected(fixture, parseChunkedRows(fixture.csv, chunkSize))).toEqual(fixture.expected);
      });
    }
  }
});

function parseExpected(fixture: Rfc4180Case, rows: string[][]): ExpectedRows | ExpectedObjects {
  return fixture.mode === 'header' ? rowsToObjects(rows) : rows;
}
