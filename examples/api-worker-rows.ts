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

/**
 * Parse and materialize projected rows in parallel Bun workers.
 *
 * Workers receive CSV-safe byte ranges, so a shard never starts in the middle
 * of a quoted record. Batches are yielded as workers finish; do not rely on
 * global file order when consuming the parallel row stream.
 */
const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);

// Worker rows support the same native filters and Boolean groups as serial
// rows. The physical filter column does not have to appear in the projection.
const rowBatches = csv.rows(FILE, {
  chunkSize: CHUNK_SIZE,
  columns: COLUMNS,
  delimiter: DELIMITER,
  workerCount: WORKERS,
  where: FILTER_VALUE === undefined ? undefined : csv.column(FILTER_COLUMN).equals(FILTER_VALUE),
});

let printed = 0;
// Worker messages already contain materialized strings; the main thread does
// not retain native batch handles while these row arrays are consumed.
for await (const rows of rowBatches) {
  for (const row of rows) {
    console.log(row);
    printed += 1;
    if (printed >= LIMIT) {
      // This CLI exits immediately after printing enough rows. A service should
      // cancel or close iteration cooperatively so worker cleanup can finish.
      process.exit(0);
    }
  }
}
