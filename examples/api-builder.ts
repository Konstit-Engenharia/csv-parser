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
 * Compose a projected, optionally filtered query with the fluent API.
 *
 * Builder methods are immutable: each call returns a new builder and leaves
 * the previous one unchanged. This makes a configured base query safe to reuse
 * for several independent operations.
 */
const baseQuery = csv
  .file(FILE)
  .delimiter(DELIMITER)
  .chunkSize(CHUNK_SIZE)
  .select(COLUMNS);

// Call `rows()` within each branch so TypeScript retains the builder's precise
// filtered/unfiltered type state. The filter column is a zero-based physical
// source-column index, not a position within projected `COLUMNS`.
const rowBatches = FILTER_VALUE === undefined
  ? baseQuery.rows()
  : baseQuery.whereEquals(FILTER_COLUMN, FILTER_VALUE).rows();

let printed = 0;
// `rows()` yields one materialized JavaScript row array per native input batch.
// Each output row follows the exact order in `COLUMNS`.
for await (const rows of rowBatches) {
  for (const row of rows) {
    console.log(row);
    printed += 1;
    if (printed >= LIMIT) {
      // This executable example terminates immediately once it has enough
      // output. Library code should normally stop through its own cancellation
      // or iteration lifecycle instead of calling `process.exit()`.
      process.exit(0);
    }
  }
}
