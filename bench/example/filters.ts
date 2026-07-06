import {
  countCsvFile,
  countCsvFileWhereEquals,
  parseCsvFileProjected,
} from '../../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  type ExampleBenchCase,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
  SELECTED_COLUMNS,
} from './config.ts';

export const filterCases = [
  ['native count', () => countCsvFile(FILE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER })],
  ['native filter equals', () =>
    countCsvFileWhereEquals(FILE, FILTER_COLUMN, FILTER_VALUE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
    })],
  ['native projected filter equals', () => countNativeProjectedFilteredRows()],
] as const satisfies readonly ExampleBenchCase[];

async function countNativeProjectedFilteredRows(): Promise<number> {
  let rows = 0;
  for await (
    const batch of parseCsvFileProjected(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      selectedColumns: SELECTED_COLUMNS,
      equalsFilter: {
        column: FILTER_COLUMN,
        value: FILTER_VALUE,
      },
    })
  ) {
    rows += batch.length;
  }
  return rows;
}
