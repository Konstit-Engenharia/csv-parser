import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  COLUMNS,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
  LIMIT,
} from './config.ts';

let printed = 0;
const options = {
  chunkSize: CHUNK_SIZE,
  columns: COLUMNS,
  delimiter: DELIMITER,
  where: FILTER_VALUE === undefined ? undefined : { column: FILTER_COLUMN, equals: FILTER_VALUE },
};

for await (const rows of csv.rows(FILE, options)) {
  for (const row of rows) {
    console.log(row);
    printed += 1;
    if (printed >= LIMIT) {
      process.exit(0);
    }
  }
}
