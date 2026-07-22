import { heapStats } from 'bun:jsc';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import {
  CsvStringCache,
  NativeCsvParser,
} from '../src/index.ts';

type Mode = 'selected' | 'full' | 'views';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const MODE = (Bun.env['CSV_STRING_HEAP_MODE'] ?? Bun.argv[2] ?? 'selected') as Mode;
const MAX_CHUNKS = Number(Bun.env['CSV_STRING_HEAP_CHUNKS'] ?? 12);
const SELECTED_COLUMNS = (Bun.env['CSV_BENCH_COLUMNS'] ?? '0,4,19')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);
const CACHE_COLUMNS = (Bun.env['CSV_STRING_CACHE_COLUMNS'] ?? '')
  .split(',')
  .filter((value) => value.trim() !== '')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);

const parser = new NativeCsvParser({ delimiter: DELIMITER });
const stringCache = CACHE_COLUMNS.length === 0 ? undefined : new CsvStringCache({ columns: CACHE_COLUMNS });
const rowsBuffer: string[][] = [];
const bytes = statSync(FILE).size;
let chunks = 0;
let rows = 0;
let cells = 0;
let maxHeapSize = 0;
let maxObjectCount = 0;
let maxArrayCount = 0;
let maxStringCount = 0;
let decodeMs = 0;

Bun.gc(true);
const before = summarizeHeap(heapStats());
const startedAt = performance.now();

try {
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    const batch = parser.writeBatch(chunk as Buffer);
    try {
      const decodeStart = performance.now();
      if (MODE === 'views') {
        rows += batch.rowCount;
        cells += batch.totalFields;
        batch.data();
        batch.rowOffsets();
        batch.fieldOffsets();
      } else {
        const columns = MODE === 'selected' ? SELECTED_COLUMNS : undefined;
        const materialized = batch.rowsInto(rowsBuffer, columns, stringCache);
        rows += materialized.length;
        cells += countCells(materialized);
      }
      decodeMs += performance.now() - decodeStart;

      const current = summarizeHeap(heapStats());
      maxHeapSize = Math.max(maxHeapSize, current.heapSize);
      maxObjectCount = Math.max(maxObjectCount, current.objectCount);
      maxArrayCount = Math.max(maxArrayCount, current.arrayCount);
      maxStringCount = Math.max(maxStringCount, current.stringCount);
    } finally {
      batch.close();
    }

    ++chunks;
    if (chunks >= MAX_CHUNKS) {
      break;
    }
  }
} finally {
  parser.close();
}

Bun.gc(true);
const after = summarizeHeap(heapStats());
const seconds = (performance.now() - startedAt) / 1000;

console.log({
  mode: MODE,
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  chunks,
  rows,
  cells,
  selectedColumns: SELECTED_COLUMNS,
  cacheColumns: CACHE_COLUMNS,
  cacheStats: stringCache?.stats() ?? [],
  seconds,
  decodeSeconds: decodeMs / 1000,
  rowsPerSecond: rows / seconds,
  cellsPerSecond: cells / seconds,
  heapBefore: before,
  heapPeak: {
    heapSize: maxHeapSize,
    objectCount: maxObjectCount,
    arrayCount: maxArrayCount,
    stringCount: maxStringCount,
  },
  heapAfter: after,
});

function countCells(rows: string[][]): number {
  let count = 0;
  for (const row of rows) {
    count += row.length;
  }
  return count;
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
