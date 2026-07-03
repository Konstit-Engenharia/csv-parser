import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../src/index.ts';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const MAX_CHUNKS = Number(Bun.env['CSV_CARDINALITY_CHUNKS'] ?? 120);
const SELECTED_COLUMNS = (Bun.env['CSV_BENCH_COLUMNS'] ?? '0,4,19')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);
const TOP_N = Number(Bun.env['CSV_CARDINALITY_TOP'] ?? 8);

const parser = new NativeCsvParser({ delimiter: DELIMITER });
const maps = SELECTED_COLUMNS.map(() => new Map<string, number>());
let chunks = 0;
let rows = 0;
const startedAt = performance.now();

try {
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    const batch = parser.writeBatch(chunk as Buffer);
    try {
      const data = batch.data();
      const rowOffsets = batch.rowOffsets();
      const fieldOffsets = batch.fieldOffsets();
      const rowCount = batch.rowCount;
      rows += rowCount;

      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        const fieldStart = rowOffsets[rowIndex] ?? 0;
        const fieldEnd = rowOffsets[rowIndex + 1] ?? fieldStart;
        for (let outputIndex = 0; outputIndex < SELECTED_COLUMNS.length; ++outputIndex) {
          const column = SELECTED_COLUMNS[outputIndex] ?? 0;
          const fieldIndex = fieldStart + column;
          const counts = maps[outputIndex];
          if (counts === undefined) {
            continue;
          }
          if (fieldIndex >= fieldEnd) {
            counts.set('', (counts.get('') ?? 0) + 1);
            continue;
          }

          const start = fieldOffsets[fieldIndex] ?? 0;
          const end = fieldOffsets[fieldIndex + 1] ?? start;
          const value = data.toString('utf8', start, end);
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
      }
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

console.log(JSON.stringify({
  file: FILE,
  chunkSize: CHUNK_SIZE,
  chunks,
  rows,
  selectedColumns: SELECTED_COLUMNS,
  seconds: (performance.now() - startedAt) / 1000,
  columns: SELECTED_COLUMNS.map((column, index) => {
    const counts = maps[index] ?? new Map<string, number>();
    const top = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, TOP_N)
      .map(([value, count]) => ({ value, count }));
    return {
      column,
      unique: counts.size,
      duplicateRatio: rows === 0 ? 0 : 1 - counts.size / rows,
      top,
    };
  }),
}, null, 2));
