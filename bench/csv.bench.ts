import { summary } from 'mitata';
import { registerSyntheticLatin1Benches } from './synthetic/latin1.ts';
import { registerSyntheticUtf8Benches } from './synthetic/utf8.ts';

const ROWS = Number(Bun.env['CSV_BENCH_ROWS'] ?? 100_000);

summary(() => {
  registerSyntheticUtf8Benches(ROWS);
  registerSyntheticLatin1Benches(ROWS);
});
