import {
  describe,
  expect,
  test,
} from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  countCsvFileWhereEquals,
  countCsvFileWhereIn,
  countCsvFileWhereStartsWith,
  NativeCsvParser,
} from '../src/index.ts';

describe('NativeCsvParser native filters', () => {
  test('projects and filters inside native parser', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    const rows: string[][] = [];
    const options = {
      selectedColumns: [2, 0],
      equalsFilter: { column: 2, value: 'SP' },
    };

    try {
      let batch = parser.writeProjectedBatch(Buffer.from('"id";"name";"uf"\n"1";'), options);
      try {
        rows.push(...batch.rows());
      } finally {
        batch.close();
      }

      batch = parser.writeProjectedBatch(Buffer.from('"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"SP"\n'), options);
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
    const input = Buffer.from('a,b,c\n1,2,3\n4,5,6\n');
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

  test('streams ordered and duplicate projections across tiny chunks', () => {
    const input = Buffer.from('a,b,c\n"x\nx",y,z\n1,2,3');

    for (const selectedColumns of [[0, 2], [2, 0, 2]]) {
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

        expect(rows).toEqual(selectedColumns.length === 2
          ? [['a', 'c'], ['x\nx', 'z'], ['1', '3']]
          : [['c', 'a', 'c'], ['z', 'x\nx', 'z'], ['3', '1', '3']]);
      } finally {
        parser.close();
      }
    }
  });

  test('countCsvFileWhereEquals filters natively by column bytes', async () => {
    const path = join(import.meta.dir, 'tmp-filter.csv');
    await Bun.write(path, '"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"SP"\n');
    try {
      expect(await countCsvFileWhereEquals(path, 2, 'SP', { delimiter: ';' })).toBe(2);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('countCsvFileWhereIn filters natively by a set of byte values', async () => {
    const path = join(import.meta.dir, 'tmp-filter-in.csv');
    await Bun.write(
      path,
      '"id";"name";"uf"\n"1";"Ana";"SP"\n"2";"Joao";"RJ"\n"3";"Bia";"MG"\n"4";"Lia";"SP"\n',
    );
    try {
      expect(await countCsvFileWhereIn(path, 2, ['SP', 'RJ'], { delimiter: ';', chunkSize: 11 })).toBe(3);
      expect(await countCsvFileWhereIn(path, 2, [Buffer.from('MG')], { delimiter: ';', chunkSize: 7 })).toBe(1);
      expect(await countCsvFileWhereIn(path, 2, [], { delimiter: ';' })).toBe(0);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('countCsvFileWhereStartsWith filters natively by prefix bytes', async () => {
    const path = join(import.meta.dir, 'tmp-filter-prefix.csv');
    await Bun.write(
      path,
      '"id";"name";"city"\n"1";"Ana";"Sao Paulo"\n"2";"Joao";"Rio"\n"3";"Bia";"Santos"\n',
    );
    try {
      expect(await countCsvFileWhereStartsWith(path, 2, 'Sa', { delimiter: ';', chunkSize: 13 })).toBe(2);
      expect(await countCsvFileWhereStartsWith(path, 2, Buffer.from('Rio'), { delimiter: ';', chunkSize: 9 })).toBe(1);
    } finally {
      rmSync(path, { force: true });
    }
  });

  test('NativeCsvParser streams in and startsWith native filters across chunks', () => {
    const parser = new NativeCsvParser({ delimiter: ';' });
    try {
      let count = 0;
      count += parser.writeCountWhereIn(Buffer.from('"id";"uf"\n"1";"S'), { column: 1, values: ['SP', 'RJ'] });
      count += parser.writeCountWhereIn(Buffer.from('P"\n"2";"RJ"\n"3";"MG"\n'), { column: 1, values: ['SP', 'RJ'] });
      count += parser.endCountWhereIn({ column: 1, values: ['SP', 'RJ'] });
      expect(count).toBe(2);
    } finally {
      parser.close();
    }

    const startsWithParser = new NativeCsvParser({ delimiter: ';' });
    try {
      let count = 0;
      count += startsWithParser.writeCountWhereStartsWith(Buffer.from('"id";"city"\n"1";"Sa'), {
        column: 1,
        prefix: 'Sa',
      });
      count += startsWithParser.writeCountWhereStartsWith(Buffer.from('ntos"\n"2";"Rio"\n'), {
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
      let count = 0;
      count += parser.writeCountWhereIn(Buffer.from('1;S'), { column: 1, values });
      count += parser.writeCountWhereIn(Buffer.from('P\n2;RJ\n3;\n'), { column: 1, values });
      count += parser.endCountWhereIn({ column: 1, values });
      expect(count).toBe(2);
    } finally {
      parser.close();
    }

    const latin1Values = [...missing.slice(0, 7), 'João'];
    const latin1Parser = new NativeCsvParser({ delimiter: ';', encoding: 'latin1' });
    try {
      const input = Buffer.from('1;João\n2;Márcia\n', 'latin1');
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
