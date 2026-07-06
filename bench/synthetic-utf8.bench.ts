import {
  run,
  summary,
} from 'mitata';
import { registerSyntheticUtf8Benches } from './synthetic/utf8.ts';

const ROWS = Number(Bun.env['CSV_BENCH_ROWS'] ?? 100_000);

summary(() => {
  registerSyntheticUtf8Benches(ROWS);
});

await run({ throw: true });
