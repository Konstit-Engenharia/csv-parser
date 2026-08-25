import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
} from './config.ts';

/**
 * Count all rows, then demonstrate three native filter conditions supported by
 * `count()`. Counting does not materialize row arrays, so it is the preferred
 * API when only the cardinality is needed.
 */
const baseOptions = {
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
};

// With no `where` clause, every parsed record contributes to the result.
console.log({
  rows: await csv.count(FILE, baseOptions),
});

if (FILTER_VALUE !== undefined) {
  const filterColumn = csv.column(FILTER_COLUMN);
  console.log({
    // Filter columns are zero-based physical indexes in the source CSV.
    equals: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.equals(FILTER_VALUE),
    }),
    // Prefix matching compares encoded field bytes without allocating a
    // JavaScript string for every candidate row.
    startsWith: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.startsWith(FILTER_VALUE),
    }),
    // `isOneOf` matches several exact values in one scan. This one-element input
    // intentionally makes its result directly comparable to `equals`.
    isOneOf: await csv.count(FILE, {
      ...baseOptions,
      where: filterColumn.isOneOf([FILTER_VALUE]),
    }),
  });
}
