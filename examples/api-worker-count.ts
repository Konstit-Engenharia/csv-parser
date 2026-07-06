import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
} from './config.ts';

const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);

const query = csv
  .file(FILE)
  .delimiter(DELIMITER)
  .chunkSize(CHUNK_SIZE)
  .workers(WORKERS);

if (FILTER_VALUE !== undefined) {
  query.whereEquals(FILTER_COLUMN, FILTER_VALUE);
}

console.log(await query.count());
