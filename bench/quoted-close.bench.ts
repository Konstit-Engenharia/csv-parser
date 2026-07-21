import {
  bench,
  summary,
} from 'mitata';
import { parseCsvBuffer } from '../src/index.ts';

const ROWS = Number(Bun.env['CSV_QUOTED_CLOSE_BENCH_ROWS'] ?? 20_000);
const ESCAPED_QUOTES = Number(Bun.env['CSV_QUOTED_CLOSE_ESCAPES'] ?? 64);
const input = Buffer.from(makeQuotedCloseFixture(ROWS, ESCAPED_QUOTES));

summary(() => {
  bench('native quoted close dense escaped quotes', () => {
    const rows = parseCsvBuffer(input, { delimiter: ';', encoding: 'utf8' });
    if (rows.length !== ROWS + 1) {
      throw new Error(`bad row count: ${rows.length}`);
    }
  });
});

function makeQuotedCloseFixture(rows: number, escapedQuotes: number): string {
  const escaped = '""'.repeat(escapedQuotes);
  let output = '"id";"payload";"tail"\n';
  for (let i = 0; i < rows; ++i) {
    output += `"${i}";"${escaped}end ${i}";"tail ${i}"\n`;
  }
  return output;
}
