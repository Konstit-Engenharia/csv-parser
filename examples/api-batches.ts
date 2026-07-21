import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  COLUMNS,
  DELIMITER,
  FILE,
  LIMIT,
} from './config.ts';

/**
 * Inspect native batches and zero-copy row views.
 *
 * Use this API when materializing every field as a JavaScript string would be
 * wasteful. Row views and byte views are borrowed from the current batch; copy
 * anything that must survive after the callback returns. Numeric ranges remain
 * values, but only describe offsets within that batch's data.
 */
let printed = 0;

await csv.withBatches(
  FILE,
  {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
  },
  (batch) => {
    // `withBatches()` closes each batch after this callback settles, including
    // when the callback throws. The row view itself is reused as iteration
    // advances, which keeps allocation pressure low on this hot path.
    batch.forEachRow((row) => {
      console.log({
        // `rowIndex` is local to this batch, not a file-global row number.
        rowIndex: row.rowIndex,
        fieldCount: row.fieldCount,
        // `pick()` accepts zero-based physical source-column indexes and only
        // decodes the requested fields. A missing field becomes an empty string.
        values: row.pick(COLUMNS),
        // `bytes()` avoids UTF-8 decoding. It returns a borrowed view into the
        // batch, so only inspect or copy it while this callback is active.
        firstFieldBytes: row.bytes(COLUMNS[0] ?? 0)?.byteLength ?? 0,
        // Ranges are half-open byte offsets [start, end) within batch data.
        firstFieldRange: row.range(COLUMNS[0] ?? 0),
      });
      printed += 1;
      if (printed >= LIMIT) {
        // This is a short-lived CLI example, so a hard process exit is used to
        // stop `forEachRow()` immediately. Long-running applications should use
        // cooperative cancellation so their own cleanup can complete.
        process.exit(0);
      }
    });
  },
);
