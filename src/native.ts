import {
  dlopen,
  type Library,
  type Pointer,
  suffix,
} from 'bun:ffi';
import { existsSync } from 'node:fs';
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export type { Pointer } from 'bun:ffi';
export { toArrayBuffer } from 'bun:ffi';

export const EMPTY_BUFFER = new Uint8Array(1);
export const EMPTY_U32 = new Uint32Array(1);
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;

const CSV_SYMBOLS = {
  csv_parser_create: {
    args: ['int', 'u8'],
    returns: 'ptr',
  },
  csv_parser_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_parser_reset: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_parser_write_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'ptr',
  },
  csv_parser_finish_batch: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_parser_write_strict_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'ptr',
  },
  csv_parser_finish_strict_batch: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_parser_write_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_strict_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_strict_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_trusted_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_trusted_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_strict_trusted_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_strict_trusted_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_projected_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'ptr',
  },
  csv_parser_finish_projected_batch: {
    args: ['ptr', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'ptr',
  },
  csv_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_batch_total_fields: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_batch_row_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_batch_field_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_batch_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_write_count: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'u64',
  },
  csv_parser_count_trusted_newlines: {
    args: ['buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_find_split_offsets: {
    args: ['cstring', 'u64', 'u8'],
    returns: 'ptr',
  },
  csv_split_offsets_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_split_offsets_batch_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_split_offsets_batch_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_parser_finish_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_parser_write_count_where_equals: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_write_count_where_in: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_count_where_in: {
    args: ['ptr', 'u32', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_write_count_where_starts_with: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_count_where_starts_with: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_last_error: {
    args: ['ptr'],
    returns: 'cstring',
  },
} as const;

export const native = loadNative();

function loadNative(): Library<typeof CSV_SYMBOLS> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const target = `${process.platform}-${process.arch}`;
  const candidates = [
    join(root, 'build', target, `libcsv_native.${suffix}`),
    join(root, 'build', target, 'Release', `libcsv_native.${suffix}`),
    join(root, 'prebuilds', target, `libcsv_native.${suffix}`),
    join(root, 'build', `libcsv_native.${suffix}`),
    join(root, 'build', 'Release', `libcsv_native.${suffix}`),
    join(root, `libcsv_native.${suffix}`),
  ];
  const libraryPath = candidates.find((candidate) => existsSync(candidate));
  if (libraryPath === undefined) {
    throw new Error(`native library not found. Run: bun run build:native`);
  }

  return dlopen(resolve(libraryPath), CSV_SYMBOLS);
}

export function requirePtr(ptr: Pointer | null): Pointer {
  if (ptr === null) {
    throw new Error('native CSV pointer is null');
  }
  return ptr;
}

export function u64ToSafeNumber(value: bigint | number, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${label} exceeds the JavaScript safe integer range: ${value}`);
    }
    return value;
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${label} exceeds Number.MAX_SAFE_INTEGER: ${value}`);
  }
  return Number(value);
}
