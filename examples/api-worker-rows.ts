import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  COLUMNS,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
  LIMIT,
} from './config.ts';

const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);

const query = csv
  .file(FILE)
  .delimiter(DELIMITER)
  .chunkSize(CHUNK_SIZE)
  .workers(WORKERS)
  .select(COLUMNS);

if (FILTER_VALUE !== undefined) {
  query.whereEquals(FILTER_COLUMN, FILTER_VALUE);
}

let printed = 0;
for await (const rows of query.rows()) {
  for (const row of rows) {
    console.log(row);
    printed += 1;
    if (printed >= LIMIT) {
      process.exit(0);
    }
  }
}
