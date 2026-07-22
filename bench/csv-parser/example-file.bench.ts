import {
  CHUNK_SIZE,
  DELIMITER,
  type ExampleBenchCase,
  FILE,
  runExampleBenchCases,
} from '../example/config.ts';
import { filterCases } from '../example/filters.ts';
import { materializationCases } from '../example/materialization.ts';
import { countFileWithCsvParser } from './common.ts';

const csvParserCases = [
  ['csv-parser utf8', () => countFileWithCsvParser(FILE, CHUNK_SIZE, DELIMITER)],
  ['iconv-lite latin1 + csv-parser', () => countFileWithCsvParser(FILE, CHUNK_SIZE, DELIMITER, 'latin1')],
] as const satisfies readonly ExampleBenchCase[];

await runExampleBenchCases([
  ...materializationCases,
  ...filterCases,
  ...csvParserCases,
]);
