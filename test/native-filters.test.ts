import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  countCsvFileWhereEquals,
  countCsvFileWhereIn,
  countCsvFileWhereStartsWith,
  NativeCsvParser,
} from '../src/index.ts';
import {
  csvFixturePath,
  readCsvFixture,
} from './fixtures.ts';

describe('NativeCsvParser native filters', () => {
  test('projects and filters inside native parser', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    const rows: string[][] = [];
    const options = {
      selectedColumns: [2, 0],
      equalsFilter: { column: 2, value: 'SP' },
    };

    try {
      const input = readCsvFixture('native/quoted-semicolon-people-with-header.csv');
      let batch = parser.writeProjectedBatch(input.subarray(0, 21), options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      batch = parser.writeProjectedBatch(input.subarray(21), options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      batch = parser.endProjectedBatch(options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      expect(rows).toEqual([
        ['SP', '1'],
        ['SP', '3'],
      ]);
    } finally {
      parser.close();
    }
  });

  test('projects and filters rows split across tiny chunks', () => {
    const parser = new NativeCsvParser();
    const input = readCsvFixture('native/projected-rows.csv');
    const rows: string[][] = [];
    const options = {
      selectedColumns: [0, 2],
      equalsFilter: { column: 1, value: '5' },
    };

    try {
      for (let offset = 0; offset < input.byteLength; ++offset) {
        const batch = parser.writeProjectedBatch(input.subarray(offset, offset + 1), options);
        try {
          rows.push(...batch.rows());
        } finally {
          batch.close();
        }
      }

      const batch = parser.endProjectedBatch(options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      expect(rows).toEqual([['4', '6']]);
    } finally {
      parser.close();
    }
  });

  test('streams ordered projections across tiny chunks', () => {
    const input = readCsvFixture('native/projected-multiline-rows.csv');
    const selectedColumns = [2, 0];
    const parser = new NativeCsvParser();
    const rows: string[][] = [];
    try {
      for (let offset = 0; offset < input.byteLength; ++offset) {
        const batch = parser.writeProjectedBatch(input.subarray(offset, offset + 1), { selectedColumns });
        try {
          rows.push(...batch.rows());
        } finally {
          batch.close();
        }
      }

      const batch = parser.endProjectedBatch({ selectedColumns });
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      expect(rows).toEqual([['c', 'a'], ['z', 'x\nx'], ['3', '1']]);
    } finally {
      parser.close();
    }
  });

  test('enforces projected column uniqueness and configured limits', () => {
    const parser = new NativeCsvParser();
    try {
      expect(() => parser.writeProjectedBatch(readCsvFixture('native/three-column-header.csv'), { selectedColumns: [2, 2] })).toThrow(
        'selected column repeated: 2',
      );
      expect(() => parser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), { selectedColumns: [2025] })).toThrow(
        'selected column out of range: 2025',
      );
      expect(() =>
        parser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), {
          selectedColumns: Array.from({ length: 2025 }, (_, index) => index),
        })
      ).toThrow('selected column count out of range: 2025');

      const maximumIndex = parser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), { selectedColumns: [2024] }, true);
      try {
        expect(maximumIndex.rows()).toEqual([['']]);
      } finally {
        maximumIndex.close();
      }
    } finally {
      parser.close();
    }

    const maximumProjectionParser = new NativeCsvParser();
    try {
      const selectedColumns = Array.from({ length: 2024 }, (_, index) => index);
      const batch = maximumProjectionParser.writeProjectedBatch(readCsvFixture('native/single-value.csv'), { selectedColumns }, true);
      try {
        const rows = batch.rows();
        expect(rows[0]).toHaveLength(2024);
        expect(rows[0]?.[0]).toBe('a');
        expect(rows[0]?.[2023]).toBe('');
      } finally {
        batch.close();
      }
    } finally {
      maximumProjectionParser.close();
    }
  });

  test('enforces the maximum filter column across native filter variants', () => {
    const parser = new NativeCsvParser();
    try {
      expect(parser.writeCountWhereEquals(readCsvFixture('native/single-value.csv'), { column: 2024, value: 'a' }, true)).toBe(0);
    } finally {
      parser.close();
    }

    const invalidParser = new NativeCsvParser();
    try {
      expect(() => invalidParser.writeCountWhereEquals(readCsvFixture('native/single-value.csv'), { column: 2025, value: 'a' })).toThrow(
        'filter column out of range: 2025',
      );
      expect(() => invalidParser.writeCountWhereIn(readCsvFixture('native/single-value.csv'), { column: 2025, values: ['a'] })).toThrow(
        'filter column out of range: 2025',
      );
      expect(() => invalidParser.writeCountWhereStartsWith(readCsvFixture('native/single-value.csv'), { column: 2025, prefix: 'a' }))
        .toThrow(
          'filter column out of range: 2025',
        );
    } finally {
      invalidParser.close();
    }
  });

  test('countCsvFileWhereEquals filters natively by column bytes', async () => {
    const path = csvFixturePath('native/quoted-semicolon-people-with-header.csv');
    expect(await countCsvFileWhereEquals(path, 2, 'SP', { delimiter: ';' })).toBe(2);
  });

  test('countCsvFileWhereIn filters natively by a set of byte values', async () => {
    const path = csvFixturePath('native/quoted-semicolon-people-with-mg.csv');
    expect(await countCsvFileWhereIn(path, 2, ['SP', 'RJ'], { delimiter: ';', chunkSize: 11 })).toBe(3);
    expect(await countCsvFileWhereIn(path, 2, [Buffer.from('MG')], { delimiter: ';', chunkSize: 7 })).toBe(1);
    expect(await countCsvFileWhereIn(path, 2, [], { delimiter: ';' })).toBe(0);
  });

  test('countCsvFileWhereStartsWith filters natively by prefix bytes', async () => {
    const path = csvFixturePath('native/quoted-semicolon-cities.csv');
    expect(await countCsvFileWhereStartsWith(path, 2, 'Sa', { delimiter: ';', chunkSize: 13 })).toBe(2);
    expect(await countCsvFileWhereStartsWith(path, 2, Buffer.from('Rio'), { delimiter: ';', chunkSize: 9 })).toBe(1);
  });

  test('NativeCsvParser streams in and startsWith native filters across chunks', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      const input = readCsvFixture('native/quoted-semicolon-state-filter.csv');
      let count = 0;
      count += parser.writeCountWhereIn(input.subarray(0, 16), { column: 1, values: ['SP', 'RJ'] });
      count += parser.writeCountWhereIn(input.subarray(16), { column: 1, values: ['SP', 'RJ'] });
      count += parser.endCountWhereIn({ column: 1, values: ['SP', 'RJ'] });
      expect(count).toBe(2);
    } finally {
      parser.close();
    }

    const startsWithParser = new NativeCsvParser({ delimiter: ';' });
    try {
      const input = readCsvFixture('native/quoted-semicolon-city-prefix.csv');
      let count = 0;
      count += startsWithParser.writeCountWhereStartsWith(input.subarray(0, 19), {
        column: 1,
        prefix: 'Sa',
      });
      count += startsWithParser.writeCountWhereStartsWith(input.subarray(19), {
        column: 1,
        prefix: 'Sa',
      });
      count += startsWithParser.endCountWhereStartsWith({ column: 1, prefix: 'Sa' });
      expect(count).toBe(1);
    } finally {
      startsWithParser.close();
    }
  });

  test('large in filters use hashed lookup across UTF-8 and Latin1 chunks', () => {
    const missing = Array.from({ length: 31 }, (_, index) => `missing-${index}`);
    const values = [...missing, 'SP', ''];
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      const input = readCsvFixture('native/unquoted-semicolon-states.csv');
      let count = 0;
      count += parser.writeCountWhereIn(input.subarray(0, 3), { column: 1, values });
      count += parser.writeCountWhereIn(input.subarray(3), { column: 1, values });
      count += parser.endCountWhereIn({ column: 1, values });
      expect(count).toBe(2);
    } finally {
      parser.close();
    }

    const latin1Values = [...missing.slice(0, 7), 'João'];
    const latin1Parser = new NativeCsvParser({ delimiter: ';', encoding: 'latin1' });
    try {
      const input = readCsvFixture('native/latin1-names.csv');
      let count = 0;
      count += latin1Parser.writeCountWhereIn(input.subarray(0, 5), {
        column: 1,
        values: latin1Values,
      });
      count += latin1Parser.writeCountWhereIn(input.subarray(5), {
        column: 1,
        values: latin1Values,
      });
      count += latin1Parser.endCountWhereIn({ column: 1, values: latin1Values });
      expect(count).toBe(1);
    } finally {
      latin1Parser.close();
    }
  });
});
