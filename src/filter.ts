import {
  normalizeFilterColumn,
  normalizeNativeFilterProgram,
  validateRegex,
} from './normalize.js';
import type {
  CsvNativeFilterOperator,
  CsvNativeFilterProgramEntry,
} from './normalize.js';
import type {
  CsvFieldValue,
  CsvFilter,
  CsvFilterColumn,
  CsvNativeFilter,
  CsvRegex,
} from './types.js';

const nativeProgramByFilter = new WeakMap<object, readonly CsvNativeFilterProgramEntry[]>();

export function column(columnIndex: number): CsvFilterColumn {
  const selectedColumn = normalizeFilterColumn(columnIndex);
  return Object.freeze({
    equals: (value: CsvFieldValue) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, value: copyFieldValue(value, 'equals value') }),
      ),
    doesNotEqual: (value: CsvFieldValue) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, notEquals: copyFieldValue(value, 'doesNotEqual value') }),
      ),
    isOneOf: (values: readonly CsvFieldValue[]) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, values: copyFieldValues(values, 'isOneOf values') }),
      ),
    isNoneOf: (values: readonly CsvFieldValue[]) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, notIn: copyFieldValues(values, 'isNoneOf values') }),
      ),
    startsWith: (prefix: CsvFieldValue) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, prefix: copyFieldValue(prefix, 'startsWith prefix') }),
      ),
    hasMatch: (pattern: RegExp) =>
      createFilterFromPredicate(
        Object.freeze({ column: selectedColumn, regex: re(pattern) }),
      ),
  });
}

export function all(first: CsvFilter, ...rest: readonly CsvFilter[]): CsvFilter {
  return combineFilters('all', first, rest);
}

export function any(first: CsvFilter, ...rest: readonly CsvFilter[]): CsvFilter {
  return combineFilters('any', first, rest);
}

export function not(filter: CsvFilter): CsvFilter {
  const program = requireNativeProgram(filter, 'csv.not() filter');
  return createFilter([
    ...program,
    Object.freeze({ operandCount: 1, operator: 'not' } satisfies CsvNativeFilterOperator),
  ]);
}

export function re(pattern: RegExp): CsvRegex {
  if (!(pattern instanceof RegExp)) {
    throw new TypeError('csv.re() requires a RegExp');
  }
  const regex = {
    flags: pattern.flags,
    source: pattern.source,
  };
  validateRegex(regex);
  return Object.freeze(regex) as CsvRegex;
}

export function nativeFilterProgramFor(filter: CsvFilter | undefined): readonly CsvNativeFilterProgramEntry[] | undefined {
  if (filter === undefined) {
    return undefined;
  }
  return requireNativeProgram(filter, 'where');
}

function combineFilters(
  operator: 'all' | 'any',
  first: CsvFilter,
  rest: readonly CsvFilter[],
): CsvFilter {
  if (first === undefined) {
    throw new RangeError(`csv.${operator}() requires at least one filter`);
  }
  const filters = [first, ...rest];
  const program = filters.flatMap((filter, index) => requireNativeProgram(filter, `csv.${operator}() filter ${index}`));
  program.push(Object.freeze({ operandCount: filters.length, operator }));
  return createFilter(program);
}

function createFilterFromPredicate(predicate: CsvNativeFilter): CsvFilter {
  return createFilter([predicate]);
}

function createFilter(program: readonly CsvNativeFilterProgramEntry[]): CsvFilter {
  normalizeNativeFilterProgram(program);
  const filter = Object.freeze({}) as CsvFilter;
  nativeProgramByFilter.set(filter, Object.freeze([...program]));
  return filter;
}

function requireNativeProgram(filter: CsvFilter, label: string): readonly CsvNativeFilterProgramEntry[] {
  const program = typeof filter === 'object' && filter !== null ? nativeProgramByFilter.get(filter) : undefined;
  if (program === undefined) {
    throw new TypeError(`${label} must be created with csv.column(), csv.all(), csv.any(), or csv.not()`);
  }
  return program;
}

function copyFieldValues(values: readonly CsvFieldValue[], label: string): readonly CsvFieldValue[] {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (values.length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
  return Object.freeze(values.map((value, index) => copyFieldValue(value, `${label}[${index}]`)));
}

function copyFieldValue(value: CsvFieldValue, label: string): CsvFieldValue {
  if (typeof value === 'string') {
    return value;
  }
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a string, Buffer, or Uint8Array`);
  }
  return Buffer.from(value);
}
