import {
  EMPTY_BUFFER,
  EMPTY_U32,
} from './native.ts';
import type {
  CsvColumns,
  CsvEncoding,
  CsvEqualsFilter,
  CsvFieldValue,
  CsvInFilter,
  CsvNativeFilter,
  CsvStartsWithFilter,
} from './types.ts';

export const MAX_COLUMN_INDEX = 2024;
export const MAX_PROJECTION_LENGTH = 2024;
export const MAX_FILTER_COUNT = MAX_PROJECTION_LENGTH;

const UINT32_MAX = 0xffff_ffff;
const NATIVE_FILTER_DESCRIPTOR_LENGTH = 4;
const NATIVE_FILTER_EQUALS = 1;
const NATIVE_FILTER_IN = 2;
const NATIVE_FILTER_STARTS_WITH = 3;

export function encodingCode(encoding: CsvEncoding = 'utf8'): number {
  const normalized = encoding.toLowerCase();
  if (normalized === 'utf8') {
    return 0;
  }
  if (normalized === 'latin1' || normalized === 'iso88591' || normalized === 'iso-8859-1') {
    return 1;
  }
  throw new Error(`unsupported encoding: ${encoding}`);
}

export function normalizeChunk(chunk: NodeJS.TypedArray | DataView): NodeJS.TypedArray | DataView {
  return chunk.byteLength === 0 ? EMPTY_BUFFER : chunk;
}

export function normalizeFixedColumnsCount(value: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
  return value;
}

export function normalizeColumns(columns: CsvColumns | undefined): Uint32Array {
  if (columns === undefined) {
    return EMPTY_U32;
  }

  if (columns.length > MAX_PROJECTION_LENGTH) {
    throw new RangeError(`selected column count out of range: ${columns.length}`);
  }

  const normalized = new Uint32Array(columns.length);
  const seen = new Set<number>();
  for (let index = 0; index < columns.length; ++index) {
    const column = columns[index] ?? NaN;
    normalizeColumnIndex(column, 'selected column');
    if (seen.has(column)) {
      throw new RangeError(`selected column repeated: ${column}`);
    }
    seen.add(column);
    normalized[index] = column;
  }
  return normalized.length === 0 ? EMPTY_U32 : normalized;
}

export function normalizeColumnIndex(column: number, label: string): number {
  if (!Number.isInteger(column) || column < 0 || column > MAX_COLUMN_INDEX) {
    throw new RangeError(`${label} out of range: ${column}`);
  }
  return column;
}

export function normalizeEqualsFilter(filter: CsvEqualsFilter | undefined): {
  enabled: boolean;
  column: number;
  value: Uint8Array;
  valueLength: number;
} {
  if (filter === undefined) {
    return {
      enabled: false,
      column: 0,
      value: EMPTY_BUFFER,
      valueLength: 0,
    };
  }

  normalizeColumnIndex(filter.column, 'filter column');

  const value = typeof filter.value === 'string' ? Buffer.from(filter.value) : filter.value;
  return {
    enabled: true,
    column: filter.column,
    value: value.byteLength === 0 ? EMPTY_BUFFER : value,
    valueLength: value.byteLength,
  };
}

export function normalizeFilterColumn(column: number): number {
  return normalizeColumnIndex(column, 'filter column');
}

export function normalizeFilterValue(value: CsvFieldValue): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value) : value;
}

export function normalizeInFilter(filter: CsvInFilter): {
  column: number;
  valuesData: Uint8Array;
  valuesDataLength: number;
  offsets: Uint32Array;
  valueCount: number;
} {
  const column = normalizeFilterColumn(filter.column);
  if (filter.values.length === 0) {
    throw new RangeError('filter values must not be empty');
  }

  const values = filter.values.map((value) => normalizeFilterValue(value));
  let valuesDataLength = 0;
  for (const value of values) {
    valuesDataLength += value.byteLength;
    if (valuesDataLength > 0xffff_ffff) {
      throw new RangeError('filter values exceed native offset range');
    }
  }

  const valuesData = valuesDataLength === 0 ? EMPTY_BUFFER : new Uint8Array(valuesDataLength);
  const offsets = new Uint32Array(values.length + 1);
  let offset = 0;
  for (let index = 0; index < values.length; ++index) {
    const value = values[index] ?? EMPTY_BUFFER;
    offsets[index] = offset;
    valuesData.set(value, offset);
    offset += value.byteLength;
  }
  offsets[values.length] = offset;

  return {
    column,
    valuesData,
    valuesDataLength,
    offsets,
    valueCount: values.length,
  };
}

export function normalizeStartsWithFilter(filter: CsvStartsWithFilter): {
  column: number;
  value: Uint8Array;
  valueLength: number;
} {
  const column = normalizeFilterColumn(filter.column);
  const value = normalizeFilterValue(filter.prefix);
  return {
    column,
    value: value.byteLength === 0 ? EMPTY_BUFFER : value,
    valueLength: value.byteLength,
  };
}

export function normalizeNativeFilters(filters: readonly CsvNativeFilter[] | undefined): {
  descriptors: Uint32Array;
  filterCount: number;
  valuesData: Uint8Array;
  valuesDataLength: number;
  valueOffsets: Uint32Array;
  valueCount: number;
} {
  if (filters === undefined || filters.length === 0) {
    return {
      descriptors: EMPTY_U32,
      filterCount: 0,
      valuesData: EMPTY_BUFFER,
      valuesDataLength: 0,
      valueOffsets: EMPTY_U32,
      valueCount: 0,
    };
  }
  if (filters.length > MAX_FILTER_COUNT) {
    throw new RangeError(`filter count out of range: ${filters.length}`);
  }

  const descriptors = new Uint32Array(filters.length * NATIVE_FILTER_DESCRIPTOR_LENGTH);
  const values: Uint8Array[] = [];
  let valuesDataLength = 0;
  let valueCount = 0;

  for (let filterIndex = 0; filterIndex < filters.length; ++filterIndex) {
    const filter = filters[filterIndex];
    if (filter === undefined) {
      throw new TypeError(`filter missing at index ${filterIndex}`);
    }

    const column = normalizeFilterColumn(filter.column);
    let kind: number;
    let filterValues: readonly CsvFieldValue[];
    if ('value' in filter) {
      kind = NATIVE_FILTER_EQUALS;
      filterValues = [filter.value];
    } else if ('values' in filter) {
      kind = NATIVE_FILTER_IN;
      filterValues = filter.values;
      if (filterValues.length === 0) {
        throw new RangeError('filter values must not be empty');
      }
    } else {
      kind = NATIVE_FILTER_STARTS_WITH;
      filterValues = [filter.prefix];
    }

    if (filterValues.length > UINT32_MAX - valueCount) {
      throw new RangeError('filter value count exceeds native offset range');
    }

    const descriptorIndex = filterIndex * NATIVE_FILTER_DESCRIPTOR_LENGTH;
    descriptors[descriptorIndex] = kind;
    descriptors[descriptorIndex + 1] = column;
    descriptors[descriptorIndex + 2] = valueCount;
    descriptors[descriptorIndex + 3] = filterValues.length;

    valueCount += filterValues.length;
    for (const filterValue of filterValues) {
      const value = normalizeFilterValue(filterValue);
      if (value.byteLength > UINT32_MAX - valuesDataLength) {
        throw new RangeError('filter values exceed native offset range');
      }
      values.push(value);
      valuesDataLength += value.byteLength;
    }
  }

  const valuesData = valuesDataLength === 0 ? EMPTY_BUFFER : new Uint8Array(valuesDataLength);
  const valueOffsets = new Uint32Array(valueCount + 1);
  let valueIndex = 0;
  let offset = 0;
  for (const value of values) {
    valueOffsets[valueIndex] = offset;
    valuesData.set(value, offset);
    offset += value.byteLength;
    ++valueIndex;
  }
  valueOffsets[valueCount] = offset;

  return {
    descriptors,
    filterCount: filters.length,
    valuesData,
    valuesDataLength,
    valueOffsets,
    valueCount,
  };
}
