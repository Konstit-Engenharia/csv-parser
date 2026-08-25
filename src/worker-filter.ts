import { nativeFilterProgramFor } from './filter.js';
import type {
  CsvNativeFilterOperator,
  CsvNativeFilterProgramEntry,
} from './normalize.js';
import type {
  CsvFieldValue,
  CsvFilter,
  CsvNativeFilter,
  CsvRegex,
} from './types.js';

interface WorkerEqualsFilterMessage {
  column: number;
  value: Uint8Array;
}

interface WorkerInFilterMessage {
  column: number;
  values: Uint8Array[];
}

interface WorkerNotEqualsFilterMessage {
  column: number;
  notEquals: Uint8Array;
}

interface WorkerNotInFilterMessage {
  column: number;
  notIn: Uint8Array[];
}

interface WorkerStartsWithFilterMessage {
  column: number;
  prefix: Uint8Array;
}

interface WorkerRegexFilterMessage {
  column: number;
  regex: CsvRegex;
}

export type WorkerFilterProgramEntry =
  | CsvNativeFilterOperator
  | WorkerEqualsFilterMessage
  | WorkerInFilterMessage
  | WorkerNotInFilterMessage
  | WorkerNotEqualsFilterMessage
  | WorkerRegexFilterMessage
  | WorkerStartsWithFilterMessage;

export function toWorkerFilterProgram(where: CsvFilter | undefined): WorkerFilterProgramEntry[] | undefined {
  return nativeFilterProgramFor(where)?.map(normalizeProgramEntry);
}

function normalizeProgramEntry(entry: CsvNativeFilterProgramEntry): WorkerFilterProgramEntry {
  if ('operator' in entry) {
    return {
      operandCount: entry.operandCount,
      operator: entry.operator,
    };
  }
  return normalizePredicate(entry);
}

function normalizePredicate(predicate: CsvNativeFilter): WorkerFilterProgramEntry {
  if ('value' in predicate) {
    return {
      column: predicate.column,
      value: normalizeFieldValue(predicate.value),
    };
  }
  if ('values' in predicate) {
    return {
      column: predicate.column,
      values: predicate.values.map(normalizeFieldValue),
    };
  }
  if ('notEquals' in predicate) {
    return {
      column: predicate.column,
      notEquals: normalizeFieldValue(predicate.notEquals),
    };
  }
  if ('notIn' in predicate) {
    return {
      column: predicate.column,
      notIn: predicate.notIn.map(normalizeFieldValue),
    };
  }
  if ('prefix' in predicate) {
    return {
      column: predicate.column,
      prefix: normalizeFieldValue(predicate.prefix),
    };
  }
  return {
    column: predicate.column,
    regex: predicate.regex,
  };
}

function normalizeFieldValue(value: CsvFieldValue): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value) : value;
}
