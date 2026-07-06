import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  GROUP_COLUMN,
  LIMIT,
} from './config.ts';

const batch = await csv.groupByCount(FILE, GROUP_COLUMN, {
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
});

try {
  const entries = batch
    .entries()
    .sort((left, right) => right.count - left.count)
    .slice(0, LIMIT);

  console.log({
    column: GROUP_COLUMN,
    rows: batch.rowCount,
    unique: batch.dictionaryCount,
    top: entries,
  });
} finally {
  batch.close();
}
