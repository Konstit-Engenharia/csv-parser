import {
  bench,
  run,
  summary,
} from 'mitata';
import { NativeCsvParser } from '../src/index.ts';

const ROWS = Number(Bun.env['CSV_FIELD_ACCESS_ROWS'] ?? 10_000);
const ITERATIONS = Number(Bun.env['CSV_FIELD_ACCESS_ITERATIONS'] ?? 20);
const input = makeFixture(ROWS);
const parser = new NativeCsvParser({ delimiter: ';' });
const batch = parser.writeBatch(input, true);
const expectedBytes = ROWS * ITERATIONS;

summary(() => {
  bench('NativeCsvBatch.fieldBytes', () => {
    let bytes = 0;
    for (let iteration = 0; iteration < ITERATIONS; ++iteration) {
      for (let row = 0; row < ROWS; ++row) {
        bytes += batch.fieldBytes(row, 1)?.byteLength ?? 0;
      }
    }
    if (bytes !== expectedBytes) {
      throw new Error(`bad byte count: ${bytes}`);
    }
  });

  bench('NativeCsvBatch.fieldBuffer', () => {
    let bytes = 0;
    for (let iteration = 0; iteration < ITERATIONS; ++iteration) {
      for (let row = 0; row < ROWS; ++row) {
        bytes += batch.fieldBuffer(row, 1)?.byteLength ?? 0;
      }
    }
    if (bytes !== expectedBytes) {
      throw new Error(`bad byte count: ${bytes}`);
    }
  });

  bench('NativeCsvBatch.fieldString', () => {
    let bytes = 0;
    for (let iteration = 0; iteration < ITERATIONS; ++iteration) {
      for (let row = 0; row < ROWS; ++row) {
        bytes += batch.fieldString(row, 1)?.length ?? 0;
      }
    }
    if (bytes !== expectedBytes) {
      throw new Error(`bad byte count: ${bytes}`);
    }
  });
});

try {
  await run({ throw: true });
} finally {
  batch.close();
  parser.close();
}

function makeFixture(rows: number): Buffer {
  let output = '';
  for (let row = 0; row < rows; ++row) {
    output += `${row};x;SP\n`;
  }
  return Buffer.from(output);
}
