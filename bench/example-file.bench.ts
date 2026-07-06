import { aggregateCases } from './example/aggregates.ts';
import { runExampleBenchCases } from './example/config.ts';
import { filterCases } from './example/filters.ts';
import { materializationCases } from './example/materialization.ts';

await runExampleBenchCases([
  ...materializationCases,
  ...aggregateCases,
  ...filterCases,
]);
