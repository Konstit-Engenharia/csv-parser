import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  GROUP_COLUMN,
  LIMIT,
} from './config.ts';

/**
 * Compute a frequency table for one physical CSV column without first
 * materializing every row as JavaScript strings.
 *
 * `groupByCount()` performs the aggregation in native code and returns a
 * native-backed result batch. The batch owns memory outside the JavaScript
 * heap, so callers must close it even when sorting or printing fails.
 */
const batch = await csv.groupByCount(FILE, GROUP_COLUMN, {
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
});

try {
  // `entries()` materializes the compact dictionary/count result, not the
  // original CSV rows. Sorting therefore scales with the number of distinct
  // values in GROUP_COLUMN rather than with the file's total row count.
  const entries = batch
    .entries()
    .sort((left, right) => right.count - left.count)
    .slice(0, LIMIT);

  console.log({
    // Column indexes are zero-based physical indexes in the source file.
    column: GROUP_COLUMN,
    // `rowCount` is the number of input rows included in the aggregate.
    rows: batch.rowCount,
    // `dictionaryCount` is the number of distinct values that were observed.
    unique: batch.dictionaryCount,
    top: entries,
  });
} finally {
  // Closing is idempotent, but keeping it in `finally` is important: native
  // memory must also be released on an exception or interrupted operation.
  batch.close();
}
