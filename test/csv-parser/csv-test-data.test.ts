import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  parseChunkedRows,
  parseRows,
  rowsToObjects,
} from './helpers.ts';

type ExpectedRows = string[][];
type ExpectedObjects = Array<Record<string, string>>;

interface CsvTestDataCase {
  name: string;
  csv: string;
  expected: ExpectedRows | ExpectedObjects;
  mode?: 'rows' | 'header';
}

// Valid RFC 4180 cases from https://github.com/sineemore/csv-test-data.
const cases: CsvTestDataCase[] = [
  {
    name: 'all-empty',
    csv: '\n\n',
    expected: [[''], ['']],
  },
  {
    name: 'empty-field',
    csv: 'foo,bar,baz\n1,,3',
    expected: [['foo', 'bar', 'baz'], ['1', '', '3']],
  },
  {
    name: 'empty-one-column',
    csv: 'foo\n\n',
    expected: [['foo'], ['']],
  },
  {
    name: 'header-no-rows',
    csv: 'foo,bar,baz',
    expected: [],
    mode: 'header',
  },
  {
    name: 'header-simple',
    csv: 'foo,bar,baz\n1,2,3',
    expected: [{ foo: '1', bar: '2', baz: '3' }],
    mode: 'header',
  },
  {
    name: 'leading-space',
    csv: 'foo,bar,baz\n1, leading space,3',
    expected: [['foo', 'bar', 'baz'], ['1', ' leading space', '3']],
  },
  {
    name: 'one-column',
    csv: 'foo\n1',
    expected: [['foo'], ['1']],
  },
  {
    name: 'quotes-empty',
    csv: 'foo,bar,baz\n1,"",3',
    expected: [['foo', 'bar', 'baz'], ['1', '', '3']],
  },
  {
    name: 'quotes-with-comma',
    csv: 'foo,bar,baz\n1,"Luke, I am your father.",3',
    expected: [['foo', 'bar', 'baz'], ['1', 'Luke, I am your father.', '3']],
  },
  {
    name: 'quotes-with-escaped-quote',
    csv: 'foo,bar,baz\n1,"The "" must be escaped",3',
    expected: [['foo', 'bar', 'baz'], ['1', 'The " must be escaped', '3']],
  },
  {
    name: 'quotes-with-newline',
    csv: 'foo,bar,baz\n1,"No man is an island,\nEntire of itself",3',
    expected: [['foo', 'bar', 'baz'], ['1', 'No man is an island,\nEntire of itself', '3']],
  },
  {
    name: 'quotes-with-space',
    csv: 'foo,bar,baz\n1,"Field with spaces",3',
    expected: [['foo', 'bar', 'baz'], ['1', 'Field with spaces', '3']],
  },
  {
    name: 'simple-crlf',
    csv: 'foo,bar,baz\r\n1,2,3',
    expected: [['foo', 'bar', 'baz'], ['1', '2', '3']],
  },
  {
    name: 'simple-lf',
    csv: 'foo,bar,baz\n1,2,3',
    expected: [['foo', 'bar', 'baz'], ['1', '2', '3']],
  },
  {
    name: 'trailing-newline-one-field',
    csv: 'foo\n1\n',
    expected: [['foo'], ['1']],
  },
  {
    name: 'trailing-newline',
    csv: 'foo,bar,baz\n1,2,3\n',
    expected: [['foo', 'bar', 'baz'], ['1', '2', '3']],
  },
  {
    name: 'trailing-space',
    csv: 'foo,bar,baz\n1,trailing space ,3',
    expected: [['foo', 'bar', 'baz'], ['1', 'trailing space ', '3']],
  },
  {
    name: 'utf8',
    csv: 'foo,bar,baz\n1,😎,3',
    expected: [['foo', 'bar', 'baz'], ['1', '😎', '3']],
  },
];

describe('csv-test-data RFC 4180 corpus', () => {
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

function parseExpected(fixture: CsvTestDataCase, rows: string[][]): ExpectedRows | ExpectedObjects {
  return fixture.mode === 'header' ? rowsToObjects(rows) : rows;
}
