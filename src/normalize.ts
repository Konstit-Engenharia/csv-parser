import {
  EMPTY_BUFFER,
  EMPTY_U32,
  native,
} from './native.js';
import type {
  CsvColumns,
  CsvEncoding,
  CsvEqualsFilter,
  CsvFieldValue,
  CsvInFilter,
  CsvNativeFilter,
  CsvRegex,
  CsvStartsWithFilter,
} from './types.js';

export const MAX_COLUMN_INDEX = 2024;
export const MAX_PROJECTION_LENGTH = 2024;
export const MAX_FILTER_COUNT = MAX_PROJECTION_LENGTH;

const UINT32_MAX = 0xffff_ffff;
const NATIVE_FILTER_DESCRIPTOR_LENGTH = 4;
const NATIVE_FILTER_EQUALS = 1;
const NATIVE_FILTER_IN = 2;
const NATIVE_FILTER_STARTS_WITH = 3;
const NATIVE_FILTER_REGEX = 4;
const NATIVE_FILTER_NEQ = 5;
const NATIVE_FILTER_NOIN = 6;
export const MAX_REGEX_FILTER_COUNT = 32;
const MAX_REGEX_PATTERN_BYTES = 4_096;

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

type CsvRegexInput = Pick<CsvRegex, 'flags' | 'source'>;

export function normalizeRegex(regex: CsvRegexInput): Uint8Array {
  if (typeof regex !== 'object' || regex === null || typeof regex.source !== 'string' || typeof regex.flags !== 'string') {
    throw new TypeError('regex must be created with csv.re()');
  }

  const unsupportedFlags = regex.flags.replace(/[imsu]/g, '');
  if (unsupportedFlags.length > 0) {
    throw new Error(`unsupported regular expression flags: ${unsupportedFlags}`);
  }
  if (new Set(regex.flags).size !== regex.flags.length) {
    throw new Error(`duplicate regular expression flags: ${regex.flags}`);
  }

  const compatibleSource = convertJavaScriptRegexSource(regex.source, regex.flags.includes('u'));
  const re2Flags = regex.flags.replace('u', '');
  const source = re2Flags.length === 0 ? compatibleSource : `(?${re2Flags}:${compatibleSource})`;
  const encoded = Buffer.from(source);
  if (encoded.byteLength > MAX_REGEX_PATTERN_BYTES) {
    throw new RangeError(`regular expression exceeds ${MAX_REGEX_PATTERN_BYTES} UTF-8 bytes`);
  }
  return encoded.byteLength === 0 ? EMPTY_BUFFER : encoded;
}

export function validateRegex(regex: CsvRegexInput): void {
  const pattern = normalizeRegex(regex);
  const error = native.symbols.csv_regex_validate(pattern, pattern);
  if (error !== null && error.length > 0) {
    throw new SyntaxError(error);
  }
}

function convertJavaScriptRegexSource(source: string, unicode: boolean): string {
  let compatible = '';
  for (let index = 0; index < source.length;) {
    if (source[index] !== '\\') {
      compatible += source[index];
      ++index;
      continue;
    }

    const escapedCharacter = source[index + 1];
    if (escapedCharacter === undefined) {
      compatible += '\\';
      break;
    }
    if (escapedCharacter === '\\') {
      compatible += '\\\\';
      index += 2;
      continue;
    }
    if (escapedCharacter === '/') {
      compatible += '/';
      index += 2;
      continue;
    }
    if (escapedCharacter !== 'u') {
      compatible += `\\${escapedCharacter}`;
      index += 2;
      continue;
    }

    if (source[index + 2] === '{') {
      if (!unicode) {
        compatible += '\\u';
        index += 2;
        continue;
      }
      const close = source.indexOf('}', index + 3);
      const digits = close === -1 ? '' : source.slice(index + 3, close);
      if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) {
        throw new SyntaxError('invalid JavaScript Unicode escape in regular expression');
      }
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10_ffff || isSurrogate(codePoint)) {
        throw new SyntaxError('regular expression contains an unsupported Unicode surrogate');
      }
      compatible += `\\x{${codePoint.toString(16)}}`;
      index = close + 1;
      continue;
    }

    const digits = source.slice(index + 2, index + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
      compatible += '\\u';
      index += 2;
      continue;
    }
    let codePoint = Number.parseInt(digits, 16);
    index += 6;
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const lowDigits = source.slice(index + 2, index + 6);
      if (source.slice(index, index + 2) !== '\\u' || !/^[0-9a-fA-F]{4}$/.test(lowDigits)) {
        throw new SyntaxError('regular expression contains an unsupported Unicode surrogate');
      }
      const low = Number.parseInt(lowDigits, 16);
      if (low < 0xdc00 || low > 0xdfff) {
        throw new SyntaxError('regular expression contains an unsupported Unicode surrogate');
      }
      codePoint = 0x1_0000 + ((codePoint - 0xd800) << 10) + low - 0xdc00;
      index += 6;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      throw new SyntaxError('regular expression contains an unsupported Unicode surrogate');
    }
    compatible += `\\x{${codePoint.toString(16)}}`;
  }
  return compatible;
}

function isSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
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
  let regexFilterCount = 0;

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
    } else if ('notEquals' in filter) {
      kind = NATIVE_FILTER_NEQ;
      filterValues = [filter.notEquals];
    } else if ('notIn' in filter) {
      kind = NATIVE_FILTER_NOIN;
      filterValues = filter.notIn;
      if (filterValues.length === 0) {
        throw new RangeError('filter values must not be empty');
      }
    } else if ('prefix' in filter) {
      kind = NATIVE_FILTER_STARTS_WITH;
      filterValues = [filter.prefix];
    } else {
      ++regexFilterCount;
      if (regexFilterCount > MAX_REGEX_FILTER_COUNT) {
        throw new RangeError(`regex filter count out of range: ${regexFilterCount}`);
      }
      kind = NATIVE_FILTER_REGEX;
      filterValues = [normalizeRegex(filter.regex)];
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
