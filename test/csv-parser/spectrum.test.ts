import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  readdirSync,
  readFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import {
  dirname,
  join,
} from 'node:path';
import {
  type CsvRow,
  NativeCsvParser,
  parseCsvBuffer,
} from '../../src/index.ts';

interface SpectrumCase {
  name: string;
  csv: Buffer;
  expected: Array<Record<string, string>>;
}

const require = createRequire(import.meta.url);
const spectrumRoot = dirname(require.resolve('csv-spectrum/package.json'));
const cases = loadSpectrumCases();

describe('csv-spectrum compatibility', () => {
  for (const fixture of cases) {
    test(`${fixture.name} matches expected JSON`, () => {
      expect(rowsToObjects(parseCsvBuffer(fixture.csv))).toEqual(fixture.expected);
    });

    for (const chunkSize of [1, 2, 7, 64]) {
      test(`${fixture.name} matches expected JSON with ${chunkSize}-byte chunks`, () => {
        expect(rowsToObjects(parseChunked(fixture.csv, chunkSize))).toEqual(fixture.expected);
      });
    }
  }
});

function loadSpectrumCases(): SpectrumCase[] {
  return readdirSync(join(spectrumRoot, 'csvs'))
    .filter((file) => file.endsWith('.csv'))
    .sort()
    .map((file) => {
      const name = file.slice(0, -'.csv'.length);
      return {
        name,
        csv: readFileSync(join(spectrumRoot, 'csvs', file)),
        expected: loadExpected(name),
      };
    });
}

function loadExpected(name: string): Array<Record<string, string>> {
  const value = JSON.parse(readFileSync(join(spectrumRoot, 'json', `${name}.json`), 'utf8')) as
    | Array<Record<string, string>>
    | Record<string, string>;

  if (name === 'location_coordinates') {
    return [{
      ...singleObject(value),
      // csv-spectrum 2.0.0 has 1234567890 in JSON but 2095257564 in CSV.
      'Contact Phone Number': '2095257564',
    }];
  }

  return Array.isArray(value) ? value : [value];
}

function singleObject(value: Array<Record<string, string>> | Record<string, string>): Record<string, string> {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) {
      throw new Error('expected non-empty csv-spectrum object array');
    }
    return first;
  }
  return value;
}

function parseChunked(input: Buffer, chunkSize: number): CsvRow[] {
  const parser = new NativeCsvParser();
  const rows: CsvRow[] = [];
  try {
    for (let offset = 0; offset < input.byteLength; offset += chunkSize) {
      const batch = parser.writeBatch(input.subarray(offset, offset + chunkSize));
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }
    }

    const batch = parser.endBatch();
    try {
      rows.push(...batch.rows());
    } finally {
      batch.close();
    }
    return rows;
  } finally {
    parser.close();
  }
}

function rowsToObjects(rows: CsvRow[]): Array<Record<string, string>> {
  const [headers, ...records] = rows;
  if (headers === undefined) {
    return [];
  }

  return records.map((row) => {
    const object: Record<string, string> = {};
    for (let index = 0; index < headers.length; ++index) {
      object[headers[index] ?? ''] = row[index] ?? '';
    }
    return object;
  });
}
