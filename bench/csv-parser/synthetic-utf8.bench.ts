import {
  bench,
  run,
  summary,
} from 'mitata';
import { makeUtf8Fixture } from '../synthetic/fixtures.ts';
import { registerSyntheticUtf8Benches } from '../synthetic/utf8.ts';
import { countBufferWithCsvParser } from './common.ts';

const ROWS = Number(Bun.env['CSV_BENCH_ROWS'] ?? 100_000);
const utf8 = makeUtf8Fixture(ROWS);

summary(() => {
  registerSyntheticUtf8Benches(ROWS);

  bench('csv-parser utf8', async () => {
    const parsedRows = await countBufferWithCsvParser(utf8);
    if (parsedRows !== ROWS + 1) {
      throw new Error(`bad row count: ${parsedRows}`);
    }
  });
});

await run({ throw: true });
