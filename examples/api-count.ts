import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
} from './config.ts';

const baseOptions = {
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
};

console.log({
  rows: await csv.count(FILE, baseOptions),
});

if (FILTER_VALUE !== undefined) {
  console.log({
    equals: await csv.count(FILE, {
      ...baseOptions,
      where: { column: FILTER_COLUMN, equals: FILTER_VALUE },
    }),
    startsWith: await csv.count(FILE, {
      ...baseOptions,
      where: { column: FILTER_COLUMN, startsWith: FILTER_VALUE },
    }),
    in: await csv.count(FILE, {
      ...baseOptions,
      where: { column: FILTER_COLUMN, in: [FILTER_VALUE] },
    }),
  });
}
