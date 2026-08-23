import {
  expect,
  test,
} from 'bun:test';
import { rowsToObjects } from './csv-parser/helpers.ts';

test('rowsToObjects handles input without a header row', () => {
  expect(rowsToObjects([])).toEqual([]);
});
