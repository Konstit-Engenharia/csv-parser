import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
} from './config.ts';

/**
 * Count record-safe file shards in parallel with Bun workers. Worker fan-out is
 * most useful for large files where parsing time outweighs worker startup and
 * message-passing overhead.
 */
// `.workers()` requires an integer greater than one. The file can still yield
// fewer non-empty shards when it is too small for the requested parallelism.
const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);

const baseQuery = csv
  .file(FILE)
  .delimiter(DELIMITER)
  .chunkSize(CHUNK_SIZE)
  .workers(WORKERS);

// Builder methods are immutable, so count from the returned filtered builder.
// Branching at the operation also preserves the builder's precise type state.
// Parallel count supports equals, starts-with, and membership filters; this
// example uses the convenience method for equality.
const count = FILTER_VALUE === undefined
  ? await baseQuery.count()
  : await baseQuery.whereEquals(FILTER_COLUMN, FILTER_VALUE).count();

// Each worker returns a shard-local count. The main thread sums those values
// and rejects if the total cannot be represented as a safe JavaScript number.
console.log(count);
