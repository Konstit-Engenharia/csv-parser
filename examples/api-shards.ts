import { csv } from '../src/index.ts';

const FILE = Bun.env['CSV_EXAMPLE_FILE'] ?? Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const SHARDS = Number(Bun.env['CSV_SHARD_COUNT'] ?? 4);

const offsets = csv.findCsvSafeSplitOffsets(FILE, SHARDS, { delimiter: DELIMITER });
const shards = csv.findCsvSafeShards(FILE, SHARDS, { delimiter: DELIMITER });

console.log(JSON.stringify({
  delimiter: DELIMITER,
  file: FILE,
  offsets,
  shardCount: SHARDS,
  shards,
}, null, 2));
