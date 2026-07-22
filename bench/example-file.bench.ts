import { runExampleBenchCases } from './example/config.ts';
import { filterCases } from './example/filters.ts';
import { materializationCases } from './example/materialization.ts';

await runExampleBenchCases([
  ...materializationCases,
  ...filterCases,
]);
