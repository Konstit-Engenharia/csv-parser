import { heapStats } from 'bun:jsc';
import { statSync } from 'node:fs';
import { countFileWithCsvParser } from './common.ts';

type CsvParserProfileMode = 'csv-parser' | 'iconv-csv-parser';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const MODE = (Bun.env['CSV_PROFILE_MODE'] ?? Bun.argv[2] ?? 'csv-parser') as CsvParserProfileMode;
const bytes = statSync(FILE).size;

Bun.gc(true);
const before = heapStats();
const startedAt = performance.now();
const rows = await runMode(MODE);
Bun.gc(true);
const endedAt = performance.now();
const after = heapStats();
const seconds = (endedAt - startedAt) / 1000;

console.log(JSON.stringify(
  {
    mode: MODE,
    file: FILE,
    bytes,
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    rows,
    seconds,
    mibPerSecond: bytes / 1024 / 1024 / seconds,
    heapBefore: summarizeHeap(before),
    heapAfter: summarizeHeap(after),
  },
  null,
  2,
));

function runMode(mode: CsvParserProfileMode): Promise<number> {
  switch (mode) {
    case 'csv-parser':
      return countFileWithCsvParser(FILE, CHUNK_SIZE, DELIMITER);
    case 'iconv-csv-parser':
      return countFileWithCsvParser(FILE, CHUNK_SIZE, DELIMITER, 'latin1');
  }
}

function summarizeHeap(stats: ReturnType<typeof heapStats>) {
  return {
    heapSize: stats.heapSize,
    heapCapacity: stats.heapCapacity,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
    arrayCount: stats.objectTypeCounts['Array'] ?? 0,
    stringCount: stats.objectTypeCounts['string'] ?? 0,
    objectTypeCount: stats.objectTypeCounts['Object'] ?? 0,
  };
}
