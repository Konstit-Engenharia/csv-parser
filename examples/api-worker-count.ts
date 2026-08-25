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
// The file can yield fewer non-empty shards than requested when it is too small
// for the configured parallelism.
const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);

// The same immutable filter API works in serial calls, one-shot workers, and
// reusable worker pools. Each worker evaluates it in the native parser.
const count = await csv.count(FILE, {
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  workerCount: WORKERS,
  where: FILTER_VALUE === undefined ? undefined : csv.column(FILTER_COLUMN).equals(FILTER_VALUE),
});

// Each worker returns a shard-local count. The main thread sums those values
// and rejects if the total cannot be represented as a safe JavaScript number.
console.log(count);
