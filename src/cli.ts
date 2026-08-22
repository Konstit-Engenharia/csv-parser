#!/usr/bin/env bun

import { parseArgs } from 'node:util';
import { csv } from './api.ts';
import {
  MAX_FILTER_COUNT,
  MAX_REGEX_FILTER_COUNT,
  normalizeColumns,
  normalizeFilterColumn,
  normalizeFixedColumnsCount,
} from './normalize.ts';
import type {
  CsvApiFileOptions,
  CsvCompression,
  CsvCountOptions,
  CsvDelimiter,
  CsvEncoding,
  CsvWhereFilter,
  CsvWherePredicate,
} from './types.ts';

const help = `Usage: csv <command>

Commands:
  count <path> [options]  Count CSV records

Options:
  -h, --help              Show this help

Run 'csv count --help' for count options.

Run without installing:
  bunx @konstit/csv count <path>`;

const countHelp = `Usage: csv count <path> [options]

Count every CSV record, including the header row.

File options:
  --delimiter <value>              One safe ASCII character or auto (default: ,)
  --encoding <value>               utf8, latin1, iso88591, or iso-8859-1 (default: utf8)
  --chunk-size <bytes>             Integer from 1 through 67108864 (default: 1048576)
  --compression <format>           auto, gzip, deflate, deflate-raw, brotli, zstd, or zip (default: none)
  --zip-entry <path>               Entry used with --compression zip
  --max-compression-ratio <ratio>  ZIP expansion ratio integer from 1 through 4294967295
  --max-decompressed-bytes <bytes> Positive ZIP output byte limit

Parser options:
  --strict                         Enable strict RFC 4180 validation
  --fixed-columns <count>          Require this positive field count in strict mode
  --columns <indexes>              Validate indexes; does not change the count
  --selected-columns <indexes>     Alias for --columns; do not use both
  --expected-header <value>        Expected header; repeat per column; requires --strict
  --require-header                 Require a header row; requires --strict
  --min-data-rows <count>          Require a non-negative data row count; requires --strict

Filter option:
  --where <json>                   CsvWhereFilter JSON with string field values

Regex filters support flags i, m, s, and u, and use:
  {"column":1,"regex":{"source":"^A","flags":"i"}}

Compatibility:
  Strict mode cannot use --where.
  --fixed-columns and schema options require --strict.
  ZIP options require --compression zip and --zip-entry.

Examples:
  csv count data.csv --delimiter ';' --chunk-size 262144
  csv count data.csv --where '{"column":2,"equals":"SP"}'
  csv count data.csv --where '{"all":[{"column":2,"in":["SP","RJ"]},{"column":1,"startsWith":"A"}]}'`;

const countOptionDefinitions = {
  'columns': { type: 'string' },
  'compression': { type: 'string' },
  'delimiter': { type: 'string' },
  'encoding': { type: 'string' },
  'chunk-size': { type: 'string' },
  'expected-header': { multiple: true, type: 'string' },
  'fixed-columns': { type: 'string' },
  'help': { short: 'h', type: 'boolean' },
  'max-compression-ratio': { type: 'string' },
  'max-decompressed-bytes': { type: 'string' },
  'min-data-rows': { type: 'string' },
  'require-header': { type: 'boolean' },
  'selected-columns': { type: 'string' },
  'strict': { type: 'boolean' },
  'where': { type: 'string' },
  'zip-entry': { type: 'string' },
} as const;

const compressionFormats = new Set(['auto', 'gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd']);
const encodings = new Set(['utf8', 'latin1', 'iso88591', 'iso-8859-1']);
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

async function run(arguments_: readonly string[]): Promise<number> {
  const command = arguments_[0];
  if (command === '-h' || command === '--help') {
    console.log(help);
    return 0;
  }
  if (command === undefined) {
    return usageError('missing command');
  }
  if (command !== 'count') {
    return usageError(`unknown command: ${command}`);
  }

  let input: CountInput;
  try {
    input = parseCountInput(arguments_.slice(1));
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error), 'csv count --help');
  }
  if (input.help) {
    console.log(countHelp);
    return 0;
  }

  try {
    console.log(await csv.count(input.path, input.options));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`csv: ${message}`);
    return 1;
  }
}

interface CountInput {
  help: boolean;
  options: CsvCountOptions;
  path: string;
}

function parseCountInput(arguments_: readonly string[]): CountInput {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: [...arguments_],
    options: countOptionDefinitions,
    strict: true,
  });
  if (values.help === true) {
    return { help: true, options: {}, path: '' };
  }
  if (positionals.length !== 1) {
    throw new Error('count requires one file path');
  }

  const options: CsvApiFileOptions = {};
  if (values.delimiter !== undefined) {
    options.delimiter = parseDelimiter(values.delimiter);
  }
  if (values.encoding !== undefined) {
    options.encoding = parseEncoding(values.encoding);
  }
  if (values['chunk-size'] !== undefined) {
    options.chunkSize = parseInteger(values['chunk-size'], 'chunk size', 1, MAX_CHUNK_SIZE);
  }
  if (values.strict === true) {
    options.strict = true;
  }
  if (values['fixed-columns'] !== undefined) {
    options.fixedColumns = parseInteger(values['fixed-columns'], 'fixed columns', 1);
    normalizeFixedColumnsCount(options.fixedColumns, 'fixed column count');
  }
  if (values.columns !== undefined) {
    options.columns = parseColumns(values.columns, 'columns');
  }
  if (values['selected-columns'] !== undefined) {
    options.selectedColumns = parseColumns(values['selected-columns'], 'selected columns');
  }
  if (options.columns !== undefined && options.selectedColumns !== undefined) {
    throw new Error('use --columns or --selected-columns, not both');
  }
  if (values['expected-header'] !== undefined) {
    options.expectedHeaders = values['expected-header'];
  }
  if (values['require-header'] === true) {
    options.requireHeader = true;
  }
  if (values['min-data-rows'] !== undefined) {
    options.minDataRows = parseInteger(values['min-data-rows'], 'minimum data rows', 0);
  }
  if (values.where !== undefined) {
    options.where = parseWhere(values.where);
  }

  options.compression = parseCompression(values);
  validateCountOptionCombinations(options);
  if (!isCountOptions(options)) {
    throw new Error('count options are incompatible');
  }

  return { help: false, options, path: positionals[0] ?? '' };
}

function parseDelimiter(value: string): CsvDelimiter {
  if (value === 'auto') {
    return value;
  }
  if (
    value.length !== 1
    || value.charCodeAt(0) > 0x7f
    || value === '"'
    || value === '\r'
    || value === '\n'
  ) {
    throw new Error(`delimiter must be one safe ASCII character or auto: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseEncoding(value: string): CsvEncoding {
  if (!encodings.has(value)) {
    throw new Error(`unsupported encoding: ${value}`);
  }
  return value as CsvEncoding;
}

function parseInteger(value: string, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? `greater than or equal to ${String(minimum)}`
      : `from ${String(minimum)} through ${String(maximum)}`;
    throw new Error(`${label} must be an integer ${range}: ${value}`);
  }
  return number;
}

function parseColumns(value: string, label: string): number[] {
  const columns = value.length === 0 ? [] : value.split(',').map((column) => parseInteger(column, label, 0));
  normalizeColumns(columns);
  return columns;
}

function parseCompression(values: Record<string, boolean | string | string[] | undefined>): CsvCompression | undefined {
  const compression = values['compression'];
  const zipEntry = values['zip-entry'];
  const maxCompressionRatio = values['max-compression-ratio'];
  const maxDecompressedBytes = values['max-decompressed-bytes'];
  if (typeof compression !== 'string') {
    if (zipEntry !== undefined || maxCompressionRatio !== undefined || maxDecompressedBytes !== undefined) {
      throw new Error('ZIP options require --compression zip');
    }
    return undefined;
  }
  if (compression !== 'zip') {
    if (!compressionFormats.has(compression)) {
      throw new Error(`unsupported compression format: ${compression}`);
    }
    if (zipEntry !== undefined || maxCompressionRatio !== undefined || maxDecompressedBytes !== undefined) {
      throw new Error('ZIP options require --compression zip');
    }
    return compression as Bun.CompressionFormat | 'auto';
  }
  if (typeof zipEntry !== 'string' || zipEntry.length === 0) {
    throw new Error('--compression zip requires --zip-entry <path>');
  }

  return {
    entry: zipEntry,
    format: 'zip',
    ...(typeof maxCompressionRatio === 'string'
      ? { maxCompressionRatio: parseUint32(maxCompressionRatio, 'maximum compression ratio') }
      : {}),
    ...(typeof maxDecompressedBytes === 'string'
      ? { maxDecompressedBytes: parseInteger(maxDecompressedBytes, 'maximum decompressed bytes', 1) }
      : {}),
  };
}

function validateCountOptionCombinations(options: CsvApiFileOptions): void {
  const hasStrictSchemaOptions = options.expectedHeaders !== undefined
    || options.requireHeader === true
    || options.minDataRows !== undefined;
  if (hasStrictSchemaOptions && options.strict !== true) {
    throw new Error('--expected-header, --require-header, and --min-data-rows require --strict');
  }
  if (options.fixedColumns !== undefined && options.strict !== true) {
    throw new Error('--fixed-columns requires --strict');
  }
  if (options.strict === true && options.where !== undefined) {
    throw new Error('--strict cannot be combined with --where');
  }
}

function isCountOptions(options: CsvApiFileOptions): options is CsvCountOptions {
  if (options.columns !== undefined && options.selectedColumns !== undefined) {
    return false;
  }
  return options.strict !== true || options.where === undefined;
}

function parseUint32(value: string, label: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 0xffff_ffff) {
    throw new Error(`${label} must be an integer from 1 through 4294967295: ${value}`);
  }
  return number;
}

function parseWhere(value: string): CsvWhereFilter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--where must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) {
    throw new Error('--where must be a JSON object');
  }
  if ('all' in parsed) {
    requireExactKeys(parsed, ['all'], '--where');
    if (!Array.isArray(parsed['all']) || parsed['all'].length === 0) {
      throw new Error('--where.all must be a non-empty array');
    }
    if (parsed['all'].length > MAX_FILTER_COUNT) {
      throw new Error(`filter count out of range: ${String(parsed['all'].length)}`);
    }
    const regexFilterCount = parsed['all'].filter((predicate) => isObject(predicate) && 'regex' in predicate).length;
    if (regexFilterCount > MAX_REGEX_FILTER_COUNT) {
      throw new Error(`regex filter count out of range: ${String(regexFilterCount)}`);
    }
    return {
      all: parsed['all'].map((predicate, index) => parseWherePredicate(predicate, `--where.all[${String(index)}]`)),
    };
  }
  return parseWherePredicate(parsed, '--where');
}

function parseWherePredicate(value: unknown, label: string): CsvWherePredicate {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  const column = value['column'];
  if (typeof column !== 'number') {
    throw new Error(`${label}.column must be a number`);
  }
  normalizeFilterColumn(column);

  if ('equals' in value) {
    requireExactKeys(value, ['column', 'equals'], label);
    return { column, equals: requireString(value['equals'], `${label}.equals`) };
  }
  if ('in' in value) {
    requireExactKeys(value, ['column', 'in'], label);
    if (!Array.isArray(value['in']) || value['in'].length === 0) {
      throw new Error(`${label}.in must be a non-empty string array`);
    }
    return {
      column,
      in: value['in'].map((item, index) => requireString(item, `${label}.in[${String(index)}]`)),
    };
  }
  if ('startsWith' in value) {
    requireExactKeys(value, ['column', 'startsWith'], label);
    return { column, startsWith: requireString(value['startsWith'], `${label}.startsWith`) };
  }
  if ('regex' in value) {
    requireExactKeys(value, ['column', 'regex'], label);
    if (!isObject(value['regex'])) {
      throw new Error(`${label}.regex must contain source and optional flags strings`);
    }
    requireExactKeys(value['regex'], ['source', 'flags'], `${label}.regex`, true);
    const source = requireString(value['regex']['source'], `${label}.regex.source`);
    const flags = value['regex']['flags'] === undefined
      ? ''
      : requireString(value['regex']['flags'], `${label}.regex.flags`);
    return { column, regex: csv.re(new RegExp(source, flags)) };
  }
  throw new Error(`${label} must contain equals, in, startsWith, or regex`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
  allowMissing = false,
): void {
  const keys = Object.keys(value);
  const unknownKey = keys.find((key) => !allowedKeys.includes(key));
  if (unknownKey !== undefined) {
    throw new Error(`${label} contains unknown property: ${unknownKey}`);
  }
  if (!allowMissing) {
    const missingKey = allowedKeys.find((key) => !Object.hasOwn(value, key));
    if (missingKey !== undefined) {
      throw new Error(`${label} is missing property: ${missingKey}`);
    }
  }
}

function usageError(message: string, helpCommand = 'csv --help'): number {
  console.error(`csv: ${message}\nRun '${helpCommand}' for usage.`);
  return 2;
}

if (import.meta.main) {
  process.exitCode = await run(Bun.argv.slice(2));
}
