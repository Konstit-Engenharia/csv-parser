import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  COLUMNS,
  DELIMITER,
  FILE,
  LIMIT,
} from './config.ts';

let printed = 0;

await csv.withBatches(
  FILE,
  {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
  },
  (batch) => {
    batch.forEachRow((row) => {
      console.log({
        rowIndex: row.rowIndex,
        fieldCount: row.fieldCount,
        values: row.pick(COLUMNS),
        firstFieldBytes: row.bytes(COLUMNS[0] ?? 0)?.byteLength ?? 0,
        firstFieldRange: row.range(COLUMNS[0] ?? 0),
      });
      printed += 1;
      if (printed >= LIMIT) {
        process.exit(0);
      }
    });
  },
);
