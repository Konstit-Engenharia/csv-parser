import {
  BYTES,
  CHUNK_SIZE,
  DELIMITER,
  FILE,
} from '../example/config.ts';
import { countFileWithCsvParser } from './common.ts';

await runCountOnce('csv-parser utf8');
await runCountOnce('iconv-lite latin1 + csv-parser', 'latin1');

async function runCountOnce(name: string, encoding?: 'latin1'): Promise<void> {
  const startedAt = performance.now();
  const rows = await countFileWithCsvParser(FILE, CHUNK_SIZE, DELIMITER, encoding);
  const seconds = (performance.now() - startedAt) / 1000;

  console.log({
    mibPerSecond: BYTES / 1024 / 1024 / seconds,
    name,
    rows,
    seconds,
  });
}
