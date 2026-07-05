import {
  bench,
  run,
  summary,
} from 'mitata';
import { parseCsvBuffer } from '../src/index.ts';

const ROWS = Number(Bun.env['CSV_LATIN1_DECODE_ROWS'] ?? 50_000);
const ASCII_HEAVY = makeAsciiHeavyLatin1Fixture(ROWS);
const HIGH_BYTE = makeHighByteLatin1Fixture(ROWS);

summary(() => {
  bench('native latin1 decode ascii-heavy fields', () => {
    const rows = parseCsvBuffer(ASCII_HEAVY, { encoding: 'latin1' });
    if (rows.length !== ROWS) {
      throw new Error(`bad row count: ${rows.length}`);
    }
  });

  bench('native latin1 decode high-byte fields', () => {
    const rows = parseCsvBuffer(HIGH_BYTE, { encoding: 'latin1' });
    if (rows.length !== ROWS) {
      throw new Error(`bad row count: ${rows.length}`);
    }
  });
});

await run({ throw: true });

function makeAsciiHeavyLatin1Fixture(rows: number): Uint8Array {
  const lineLength = 32;
  const output = new Uint8Array(rows * lineLength);
  let offset = 0;
  for (let row = 0; row < rows; ++row) {
    output.set([0x4a, 0x6f, 0xe3, 0x6f, 0x20], offset);
    offset += 5;
    for (let index = 5; index < lineLength - 1; ++index) {
      output[offset++] = 0x41 + ((row + index) % 26);
    }
    output[offset++] = 0x0a;
  }
  return output;
}

function makeHighByteLatin1Fixture(rows: number): Uint8Array {
  const lineLength = 129;
  const output = new Uint8Array(rows * lineLength);
  let offset = 0;
  for (let row = 0; row < rows; ++row) {
    for (let index = 0; index < lineLength - 1; ++index) {
      output[offset++] = 0x80 + ((row + index) & 0x7f);
    }
    output[offset++] = 0x0a;
  }
  return output;
}
