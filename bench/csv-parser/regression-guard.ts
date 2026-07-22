import { performance } from 'node:perf_hooks';
import { NativeCsvParser } from '../../src/index.ts';
import { makeUtf8Fixture } from '../synthetic/fixtures.ts';
import { countBufferWithCsvParser } from './common.ts';

const ROWS = Number(Bun.env['CSV_CSV_PARSER_GUARD_ROWS'] ?? 100_000);
const SAMPLES = Number(Bun.env['CSV_CSV_PARSER_GUARD_SAMPLES'] ?? 5);
const MIN_RATIO = Number(Bun.env['CSV_CSV_PARSER_GUARD_MIN_RATIO'] ?? 3);
const EXPECTED_ROWS = ROWS + 1;

const input = makeUtf8Fixture(ROWS);

await assertRows();

const nativeMs = await measureMedian('native count buffer', countNativeRows);
const csvParserMs = await measureMedian('csv-parser count buffer', countCsvParserRows);
const ratio = csvParserMs / nativeMs;

if (ratio < MIN_RATIO) {
  throw new Error(`csv-parser regression guard: expected native >= ${MIN_RATIO.toFixed(2)}x faster, got ${ratio.toFixed(2)}x`);
}

console.log(`csv-parser guard ok: native ${ratio.toFixed(2)}x faster (${nativeMs.toFixed(2)}ms vs ${csvParserMs.toFixed(2)}ms)`);

async function assertRows(): Promise<void> {
  const nativeRows = countNativeRows();
  if (nativeRows !== EXPECTED_ROWS) {
    throw new Error(`native row count: expected ${EXPECTED_ROWS}, got ${nativeRows}`);
  }

  const csvParserRows = await countCsvParserRows();
  if (csvParserRows !== EXPECTED_ROWS) {
    throw new Error(`csv-parser row count: expected ${EXPECTED_ROWS}, got ${csvParserRows}`);
  }
}

function countNativeRows(): number {
  using parser = new NativeCsvParser();
  return parser.writeCount(input, true);
}

function countCsvParserRows(): Promise<number> {
  return countBufferWithCsvParser(input);
}

async function measureMedian(label: string, fn: () => Promise<number> | number): Promise<number> {
  await fn();

  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; ++index) {
    const start = performance.now();
    const rows = await fn();
    const elapsed = performance.now() - start;
    if (rows !== EXPECTED_ROWS) {
      throw new Error(`${label}: expected ${EXPECTED_ROWS}, got ${rows}`);
    }
    samples.push(elapsed);
  }

  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  console.log(`${label}: median ${median.toFixed(2)}ms samples=${samples.map((sample) => sample.toFixed(2)).join(',')}`);
  return median;
}
