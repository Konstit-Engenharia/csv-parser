import {
  csv,
  defineCountOptions,
  defineRowsOptions,
} from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
  FILTER_COLUMN,
  FILTER_VALUE,
  LIMIT,
} from './config.ts';

/**
 * Preserve compile-time projection information with the typed option helpers.
 * The helpers return their input unchanged at runtime; their purpose is to
 * validate option combinations and retain useful literal types for consumers.
 */
// `as const` makes this a readonly three-element tuple rather than `number[]`.
// Consequently, rows below are inferred as three-element string tuples in the
// same order as these zero-based physical source-column indexes.
const columns = [0, 1, 2] as const;

const projectedRowsOptions = defineRowsOptions({
  chunkSize: CHUNK_SIZE,
  columns,
  delimiter: DELIMITER,
  where: FILTER_VALUE === undefined ? undefined : csv.column(FILTER_COLUMN).equals(FILTER_VALUE),
});

// Count options do not need a projection because count never materializes row
// values. The helper still rejects row-only or incompatible option shapes.
const projectedCountOptions = defineCountOptions({
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
});

// Preserving `strict: true` as a literal lets the API expose only combinations
// supported by strict validation, in addition to enforcing them at runtime.
const strictCountOptions = defineCountOptions({
  ...projectedCountOptions,
  strict: true,
});

let printed = 0;

// A labeled break stops both nested loops without terminating the process. The
// async generator then runs its `finally` cleanup for the parser and batch.
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
  // Both counts cover the whole file; "projected" here refers to the row
  // example's shared file settings, not to work performed by count().
  projectedCount: await csv.count(FILE, projectedCountOptions),
  // Strict count rejects malformed structure or schema violations rather than
  // returning a partial or best-effort result.
  strictCount: await csv.count(FILE, strictCountOptions),
});
