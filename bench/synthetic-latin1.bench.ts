import {
  run,
  summary,
} from 'mitata';
import { registerSyntheticLatin1Benches } from './synthetic/latin1.ts';

const ROWS = Number(Bun.env['CSV_BENCH_ROWS'] ?? 100_000);

summary(() => {
  registerSyntheticLatin1Benches(ROWS);
});

await run({ throw: true });
