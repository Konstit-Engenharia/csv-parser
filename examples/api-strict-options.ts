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

const expectedHeaders = parseExpectedHeaders(Bun.env['CSV_EXAMPLE_EXPECTED_HEADERS']);
const requireHeader = Bun.env['CSV_EXAMPLE_REQUIRE_HEADER'] === '1';
const minDataRows = parseMinDataRows(Bun.env['CSV_EXAMPLE_MIN_DATA_ROWS']);

const strictSchema = {
  strict: true,
  ...(expectedHeaders === undefined ? {} : { expectedHeaders }),
  ...(requireHeader ? { requireHeader: true } : {}),
  ...(minDataRows === undefined ? {} : { minDataRows }),
} as const;

const strictRowsOptions = defineRowsOptions({
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  ...strictSchema,
});

const strictCountOptions = defineCountOptions({
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  ...strictSchema,
});

let printed = 0;

outer: for await (const rows of csv.rows(FILE, strictRowsOptions)) {
  for (const row of rows) {
    console.log(row);
    printed += 1;
    if (printed >= LIMIT) {
      break outer;
    }
  }
}

console.log({
  strictCount: await csv.count(FILE, strictCountOptions),
  strictSchema,
});

function parseExpectedHeaders(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function parseMinDataRows(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid CSV_EXAMPLE_MIN_DATA_ROWS: ${value}`);
  }
  return parsed;
}
