import {
  afterEach,
  expect,
  test,
} from 'bun:test';
import {
  matchesBenchmarkName,
  setBenchmarkNameFilter,
} from '../bench/benchmark-filter.ts';

afterEach(() => {
  setBenchmarkNameFilter(/.*/);
});

test('matches only benchmark names selected by the configured regex', () => {
  setBenchmarkNameFilter(/^native materialize selected columns$/);

  expect(matchesBenchmarkName('native materialize selected columns')).toBe(true);
  expect(matchesBenchmarkName('native binary batches')).toBe(false);
});

test('resets stateful regexes before matching each benchmark name', () => {
  setBenchmarkNameFilter(/native/g);

  expect(matchesBenchmarkName('native count')).toBe(true);
  expect(matchesBenchmarkName('native filter')).toBe(true);
});
