import iconv from 'iconv-lite';
import {
  bench,
  run,
  summary,
} from 'mitata';
import { makeLatin1Text } from '../synthetic/fixtures.ts';
import { registerSyntheticLatin1Benches } from '../synthetic/latin1.ts';
import { countBufferWithCsvParser } from './common.ts';

const ROWS = Number(Bun.env['CSV_BENCH_ROWS'] ?? 100_000);
const latin1 = iconv.encode(makeLatin1Text(ROWS), 'latin1');

summary(() => {
  registerSyntheticLatin1Benches(ROWS);

  bench('iconv-lite latin1 + csv-parser', async () => {
    const decoded = iconv.decode(latin1, 'latin1');
    const parsedRows = await countBufferWithCsvParser(Buffer.from(decoded));
    if (parsedRows !== ROWS + 1) {
      throw new Error(`bad row count: ${parsedRows}`);
    }
  });
});

await run({ throw: true });
