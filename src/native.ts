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
  csv_parser_write_dictionary_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  csv_parser_finish_dictionary_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_group_by_count: {
    args: ['ptr', 'buffer', 'u64', 'u32'],
    returns: 'u64',
  },
  csv_parser_finish_group_by_count: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_column_stats: {
    args: ['ptr', 'buffer', 'u64', 'u32'],
    returns: 'u64',
  },
  csv_parser_finish_column_stats: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  csv_parser_write_multi_column_stats: {
    args: ['ptr', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  csv_parser_finish_multi_column_stats: {
    args: ['ptr', 'buffer', 'u64'],
    returns: 'ptr',
  },
  csv_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_dictionary_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_group_by_count_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_group_by_count_batch_create: {
    args: ['buffer', 'u64', 'buffer', 'u64', 'buffer', 'u64', 'u64'],
    returns: 'ptr',
  },
  csv_column_stats_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_column_stats_batch_create: {
    args: ['buffer', 'u64', 'buffer', 'u64', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'ptr',
  },
  csv_multi_column_stats_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  csv_dictionary_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_dictionary_batch_dict_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_dictionary_batch_ids_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_dictionary_batch_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_dictionary_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_dictionary_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_group_by_count_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_group_by_count_batch_dict_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_group_by_count_batch_counts_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_group_by_count_batch_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_group_by_count_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_group_by_count_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_column_stats_batch_dict_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_column_stats_batch_ids_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_counts_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_column_stats_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_column_stats_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  csv_multi_column_stats_batch_column_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  csv_multi_column_stats_batch_column_at: {
    args: ['ptr', 'u64'],
    returns: 'u32',
  },
  csv_multi_column_stats_batch_take_column_batch: {
    args: ['ptr', 'u64'],
    returns: 'ptr',
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
