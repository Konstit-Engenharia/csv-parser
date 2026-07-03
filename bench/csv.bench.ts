import csvParser from 'csv-parser';
import iconv from 'iconv-lite';
import {
  bench,
  run,
  summary,
} from 'mitata';
import { Readable } from 'node:stream';
import {
  NativeCsvParser,
  parseCsvBuffer,
} from '../src/index.ts';

const ROWS = Number(Bun.env['CSV_BENCH_ROWS'] ?? 100_000);
const utf8 = makeUtf8Fixture(ROWS);
const latin1 = iconv.encode(makeLatin1Text(ROWS), 'latin1');

summary(() => {
  bench('native utf8 materialize rows(binary)', () => {
    const rows = parseCsvBuffer(utf8, { encoding: 'utf8' });
    if (rows.length !== ROWS + 1) {
      throw new Error(`bad row count: ${rows.length}`);
    }
  });

  bench('native utf8 count', () => {
    const parser = new NativeCsvParser({ encoding: 'utf8' });
    try {
      const rows = parser.writeCount(utf8, true);
      if (rows !== ROWS + 1) {
        throw new Error(`bad row count: ${rows}`);
      }
    } finally {
      parser.close();
    }
  });

  bench('csv-parser utf8', async () => {
    const rows = await countWithCsvParser(utf8);
    if (rows !== ROWS + 1) {
      throw new Error(`bad row count: ${rows}`);
    }
  });

  bench('native latin1 materialize rows(binary)', () => {
    const rows = parseCsvBuffer(latin1, { encoding: 'latin1' });
    if (rows.length !== ROWS + 1) {
      throw new Error(`bad row count: ${rows.length}`);
    }
  });

  bench('native latin1 count', () => {
    const parser = new NativeCsvParser({ encoding: 'latin1' });
    try {
      const rows = parser.writeCount(latin1, true);
      if (rows !== ROWS + 1) {
        throw new Error(`bad row count: ${rows}`);
      }
    } finally {
      parser.close();
    }
  });

  bench('iconv-lite latin1 + csv-parser', async () => {
    const decoded = iconv.decode(latin1, 'latin1');
    const rows = await countWithCsvParser(Buffer.from(decoded));
    if (rows !== ROWS + 1) {
      throw new Error(`bad row count: ${rows}`);
    }
  });
});

await run({ throw: true });

function makeUtf8Fixture(rows: number): Buffer {
  return Buffer.from(makeLatin1Text(rows));
}

function makeLatin1Text(rows: number): string {
  let output = 'id,nome,cidade,valor\n';
  for (let i = 0; i < rows; ++i) {
    output += `${i},João ${i},"São Paulo, SP",${i % 997}\n`;
  }
  return output;
}

function countWithCsvParser(input: Buffer): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    let rows = 0;
    Readable.from([input])
      .pipe(csvParser({ headers: false }))
      .on('data', () => {
        ++rows;
      })
      .on('error', reject)
      .on('end', () => {
        resolvePromise(rows);
      });
  });
}
