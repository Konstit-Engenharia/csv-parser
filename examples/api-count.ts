import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
} from './config.ts';

/**
 * Count all rows, then demonstrate the three native filter shapes supported by
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
  console.log({
    // Filter columns are zero-based physical indexes in the source CSV.
    equals: await csv.count(FILE, {
      ...baseOptions,
      where: { column: FILTER_COLUMN, equals: FILTER_VALUE },
    }),
    // Prefix matching compares encoded field bytes without allocating a
    // JavaScript string for every candidate row.
    startsWith: await csv.count(FILE, {
      ...baseOptions,
      where: { column: FILTER_COLUMN, startsWith: FILTER_VALUE },
    }),
    // `in` matches several exact values in one scan. This one-element input
    // intentionally makes its result directly comparable to `equals`.
    in: await csv.count(FILE, {
      ...baseOptions,
      where: { column: FILTER_COLUMN, in: [FILTER_VALUE] },
    }),
  });
}
