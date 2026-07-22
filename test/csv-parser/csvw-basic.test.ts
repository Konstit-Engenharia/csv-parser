import {
  describe,
  expect,
  test,
} from 'bun:test';
import { readCsvFixture } from '../fixtures.ts';
import {
  parseChunkedRows,
  parseRows,
  rowsToGeneratedColumnObjects,
  rowsToObjects,
} from './helpers.ts';

interface CsvwCase {
  name: string;
  csv: Buffer;
  expected: string[][] | Array<Record<string, string>>;
  mode?: 'rows' | 'header' | 'generated-columns';
}

// Corpus: W3C CSVW tests (https://github.com/w3c/csvw/tree/gh-pages/tests).
// Scope: raw parser subset only. Metadata transforms, comments, skipRows, datatypes and null handling are CSVW
// processor tests, not raw parser tests.
const cases: CsvwCase[] = [
  {
    name: 'test001 basic header rows',
    csv: readCsvFixture('csvw/test001-basic-header-rows.csv'),
    mode: 'header',
    expected: [
      { Surname: 'Homer', FamilyName: 'Simpson' },
      { Surname: 'Marge', FamilyName: 'Simpson' },
      { Surname: 'Bart', FamilyName: 'Simpson' },
      { Surname: 'Lisa', FamilyName: 'Simpson' },
      { Surname: 'Maggie', FamilyName: 'Simpson' },
      { Surname: 'Ned', FamilyName: 'Flanders' },
      { Surname: 'Krusty', FamilyName: 'the Clown' },
      { Surname: 'Waylon', FamilyName: 'Smithers' },
    ],
  },
  {
    name: 'test002 quoted fields',
    csv: readCsvFixture('csvw/test002-quoted-fields.csv'),
    mode: 'header',
    expected: [
      { Surname: 'Homer', FamilyName: 'Simpson' },
      { Surname: 'Marge', FamilyName: 'Simpson' },
      { Surname: 'Krusty', FamilyName: 'the Clown' },
    ],
  },
  {
    name: 'test003 whitespace preservation',
    csv: readCsvFixture('csvw/test003-whitespace-preservation.csv'),
    mode: 'header',
    expected: [
      { Surname: ' Homer ', FamilyName: ' Simpson ' },
      { Surname: ' Marge ', FamilyName: ' Simpson ' },
      { Surname: ' Krusty ', FamilyName: ' the Clown ' },
    ],
  },
  {
    name: 'test008 quoted comma path',
    csv: readCsvFixture('csvw/test008-quoted-comma-path.csv'),
    mode: 'header',
    expected: [{
      Book1: '1',
      Book2: '7680',
      Path: 'http://dbpedia.org/ontology/language,http://dbpedia.org/resource/English_language,http://dbpedia.org/ontology/language',
    }],
  },
  {
    name: 'test009 crlf rows',
    csv: readCsvFixture('csvw/test009-crlf-rows.csv'),
    mode: 'header',
    expected: [
      {
        'GID': '1',
        'On Street': 'ADDISON AV',
        'Species': 'Celtis australis',
        'Trim Cycle': 'Large Tree Routine Prune',
        'Inventory Date': '10/18/2010',
      },
      {
        'GID': '2',
        'On Street': 'EMERSON ST',
        'Species': 'Liquidambar styraciflua',
        'Trim Cycle': 'Large Tree Routine Prune',
        'Inventory Date': '6/2/2010',
      },
    ],
  },
  {
    name: 'test010 no trailing newline',
    csv: readCsvFixture('csvw/test010-no-trailing-newline.csv'),
    mode: 'header',
    expected: [
      { country: 'AD', name: 'Andorra' },
      { country: 'AF', name: 'Afghanistan' },
      { country: 'AI', name: 'Anguilla' },
      { country: 'AL', name: 'Albania' },
    ],
  },
  {
    name: 'test019 headerless generated columns',
    csv: readCsvFixture('csvw/test019-headerless-generated-columns.csv'),
    mode: 'generated-columns',
    expected: [
      {
        '_col.1': '1',
        '_col.2': 'ADDISON AV',
        '_col.3': 'Celtis australis',
        '_col.4': 'Large Tree Routine Prune',
        '_col.5': '10/18/2010',
      },
      {
        '_col.1': '2',
        '_col.2': 'EMERSON ST',
        '_col.3': 'Liquidambar styraciflua',
        '_col.4': 'Large Tree Routine Prune',
        '_col.5': '6/2/2010',
      },
    ],
  },
];

describe('W3C CSVW raw parser subset', () => {
  for (const fixture of cases) {
    test(`${fixture.name} matches expected output`, () => {
      expect(parseExpected(fixture, parseRows(fixture.csv))).toEqual(fixture.expected);
    });

    for (const chunkSize of [1, 5, 64]) {
      test(`${fixture.name} matches expected output with ${chunkSize}-byte chunks`, () => {
        expect(parseExpected(fixture, parseChunkedRows(fixture.csv, chunkSize))).toEqual(fixture.expected);
      });
    }
  }
});

function parseExpected(fixture: CsvwCase, rows: string[][]): string[][] | Array<Record<string, string>> {
  if (fixture.mode === 'header') {
    return rowsToObjects(rows);
  }
  if (fixture.mode === 'generated-columns') {
    return rowsToGeneratedColumnObjects(rows);
  }
  return rows;
}
