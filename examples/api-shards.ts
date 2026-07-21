import { csv } from '../src/index.ts';

/**
 * Find file ranges that can be parsed independently without splitting a quoted
 * CSV record. Dividing a file at arbitrary byte positions would be incorrect
 * when fields contain embedded newlines.
 */
const FILE = Bun.env['CSV_EXAMPLE_FILE'] ?? Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const SHARDS = Number(Bun.env['CSV_SHARD_COUNT'] ?? 4);

// Offsets contain record-safe shard starts plus the terminal file boundary.
// The API validates the requested count and requires a one-character delimiter.
const offsets = csv.findCsvSafeSplitOffsets(FILE, SHARDS, { delimiter: DELIMITER });

// Shards are the convenient range form. `start` and `end` are inclusive byte
// positions, and empty ranges are omitted, so a small file can produce fewer
// non-empty shards than requested.
const shards = csv.findCsvSafeShards(FILE, SHARDS, { delimiter: DELIMITER });

console.log(JSON.stringify(
  {
    delimiter: DELIMITER,
    file: FILE,
    offsets,
    shardCount: SHARDS,
    shards,
  },
  null,
  2,
));
