import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
} from './config.ts';

/**
 * Reuse a fixed worker pool across repeated operations on the same file.
 * Prefer a pool when several scans are performed: the one-shot worker APIs
 * create and terminate their workers for each operation.
 */
const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);

// `using` invokes `pool[Symbol.dispose]()` when this scope exits, including on
// an exception. Disposal terminates the Bun workers and is safe to call once
// the final awaited operation has completed.
using pool = csv.workerPool(FILE, {
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  workerCount: WORKERS,
});

// The second call reuses the pool's record-safe shards and count workers. Pool
// operations are intentionally serialized; starting another while one is busy
// rejects instead of racing shared workers.
console.log(await pool.count());
console.log(await pool.count());
