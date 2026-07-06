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

interface Rfc4180Case {
  name: string;
  csv: string;
  expected: ExpectedRows | ExpectedObjects;
  mode?: 'rows' | 'header';
}

// Corpus: project-owned RFC 4180 fixtures.
// Scope: valid parser fixtures with expected rows or header-object output.
const cases: Rfc4180Case[] = [
  {
    name: 'blank-records',
    csv: '\n\n',
    expected: [[''], ['']],
  },
  {
    name: 'empty-field',
    csv: 'id,name,score\n7,,42',
    expected: [['id', 'name', 'score'], ['7', '', '42']],
  },
  {
    name: 'empty-record-after-one-column-header',
    csv: 'token\n\n',
    expected: [['token'], ['']],
  },
  {
    name: 'header-no-rows',
    csv: 'id,name,total',
    expected: [],
    mode: 'header',
  },
  {
    name: 'header-simple',
    csv: 'id,name,total\n7,Ada,12',
    expected: [{ id: '7', name: 'Ada', total: '12' }],
    mode: 'header',
  },
  {
    name: 'leading-space',
    csv: 'id,label,value\n1, leading,9',
    expected: [['id', 'label', 'value'], ['1', ' leading', '9']],
  },
  {
    name: 'one-column',
    csv: 'token\nalpha',
    expected: [['token'], ['alpha']],
  },
  {
    name: 'quotes-empty',
    csv: 'id,label,value\n1,"",9',
    expected: [['id', 'label', 'value'], ['1', '', '9']],
  },
  {
    name: 'quotes-with-comma',
    csv: 'id,label,value\n1,"north, east",9',
    expected: [['id', 'label', 'value'], ['1', 'north, east', '9']],
  },
  {
    name: 'quotes-with-escaped-quote',
    csv: 'id,label,value\n1,"he said ""go""",9',
    expected: [['id', 'label', 'value'], ['1', 'he said "go"', '9']],
  },
  {
    name: 'quotes-with-newline',
    csv: 'id,label,value\n1,"line one\nline two",9',
    expected: [['id', 'label', 'value'], ['1', 'line one\nline two', '9']],
  },
  {
    name: 'quotes-with-space',
    csv: 'id,label,value\n1,"field with spaces",9',
    expected: [['id', 'label', 'value'], ['1', 'field with spaces', '9']],
  },
  {
    name: 'simple-crlf',
    csv: 'id,name,total\r\n7,Ada,12',
    expected: [['id', 'name', 'total'], ['7', 'Ada', '12']],
  },
  {
    name: 'simple-lf',
    csv: 'id,name,total\n7,Ada,12',
    expected: [['id', 'name', 'total'], ['7', 'Ada', '12']],
  },
  {
    name: 'trailing-newline-one-field',
    csv: 'token\nalpha\n',
    expected: [['token'], ['alpha']],
  },
  {
    name: 'trailing-newline',
    csv: 'id,name,total\n7,Ada,12\n',
    expected: [['id', 'name', 'total'], ['7', 'Ada', '12']],
  },
  {
    name: 'trailing-space',
    csv: 'id,label,value\n1,trailing ,9',
    expected: [['id', 'label', 'value'], ['1', 'trailing ', '9']],
  },
  {
    name: 'utf8',
    csv: 'id,name,total\n7,café,12',
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
