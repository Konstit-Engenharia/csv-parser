import {
  csv,
  defineCountOptions,
  defineRowsOptions,
} from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  LIMIT,
} from './config.ts';

const columns = [0, 1, 2] as const;

const projectedRowsOptions = defineRowsOptions({
  chunkSize: CHUNK_SIZE,
  columns,
  delimiter: DELIMITER,
});

const projectedCountOptions = defineCountOptions({
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
});

const strictCountOptions = defineCountOptions({
  ...projectedCountOptions,
  strict: true,
});

let printed = 0;

outer: for await (const rows of csv.rows(FILE, projectedRowsOptions)) {
  for (const row of rows) {
    console.log(row);
    printed += 1;
    if (printed >= LIMIT) {
      break outer;
    }
  }
}

console.log({
  projectedCount: await csv.count(FILE, projectedCountOptions),
  strictCount: await csv.count(FILE, strictCountOptions),
});
