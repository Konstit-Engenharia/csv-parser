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
  // C signature:
  // void* csv_parser_create(int encoding, uint8_t delimiter);
  csv_parser_create: {
    args: ['int', 'u8'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_parser_destroy(void* parser);
  csv_parser_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // void csv_parser_reset(void* parser);
  csv_parser_reset: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_batch(void* parser);
  csv_parser_finish_batch: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_strict_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_strict_batch(void* parser);
  csv_parser_finish_strict_batch: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                    uint32_t fixed_columns);
  csv_parser_write_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_fixed_batch(void* parser, uint32_t fixed_columns);
  csv_parser_finish_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_strict_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                           uint32_t fixed_columns);
  csv_parser_write_strict_fixed_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_strict_fixed_batch(void* parser, uint32_t fixed_columns);
  csv_parser_finish_strict_fixed_batch: {
    args: ['ptr', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_write_projected_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                        bool has_projection, const uint32_t* selected_columns,
  //                                        uint64_t selected_columns_len, bool has_filter,
  //                                        uint32_t filter_column, const uint8_t* filter_value,
  //                                        uint64_t filter_value_len);
  csv_parser_write_projected_batch: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'ptr',
  },
  // C signature:
  // void* csv_parser_finish_projected_batch(void* parser, bool has_projection,
  //                                         const uint32_t* selected_columns, uint64_t selected_columns_len,
  //                                         bool has_filter, uint32_t filter_column,
  //                                         const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_finish_projected_batch: {
    args: ['ptr', 'bool', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_batch_destroy(void* batch);
  csv_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // uint64_t csv_batch_row_count(void* batch);
  csv_batch_row_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_batch_total_fields(void* batch);
  csv_batch_total_fields: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_batch_data_len(void* batch);
  csv_batch_data_len: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // const uint8_t* csv_batch_data_ptr(void* batch);
  csv_batch_data_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // const uint64_t* csv_batch_row_offsets_ptr(void* batch);
  csv_batch_row_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // const uint64_t* csv_batch_field_offsets_ptr(void* batch);
  csv_batch_field_offsets_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // uint64_t csv_batch_count_where_equals(void* batch, uint32_t column, const uint8_t* value, uint64_t value_len);
  csv_batch_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final);
  csv_parser_write_count: {
    args: ['ptr', 'buffer', 'u64', 'bool'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_count_trusted_newlines(const uint8_t* data, uint64_t len);
  csv_parser_count_trusted_newlines: {
    args: ['buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // void* csv_parser_find_split_offsets(const char* path, uint64_t shard_count, uint8_t delimiter);
  csv_parser_find_split_offsets: {
    args: ['cstring', 'u64', 'u8'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_split_offsets_batch_destroy(void* batch);
  csv_split_offsets_batch_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // uint64_t csv_split_offsets_batch_count(void* batch);
  csv_split_offsets_batch_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // const uint64_t* csv_split_offsets_batch_ptr(void* batch);
  csv_split_offsets_batch_ptr: {
    args: ['ptr'],
    returns: 'ptr',
  },
  // C signature:
  // uint64_t csv_parser_finish_count(void* parser);
  csv_parser_finish_count: {
    args: ['ptr'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count_where_equals(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                              uint32_t filter_column, const uint8_t* filter_value,
  //                                              uint64_t filter_value_len);
  csv_parser_write_count_where_equals: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_finish_count_where_equals(void* parser, uint32_t filter_column,
  //                                               const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_finish_count_where_equals: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count_where_in(void* parser, const uint8_t* data, uint64_t len, bool final,
  //                                          uint32_t filter_column, const uint8_t* values_data,
  //                                          uint64_t values_data_len, const uint32_t* value_offsets,
  //                                          uint64_t value_count);
  csv_parser_write_count_where_in: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_finish_count_where_in(void* parser, uint32_t filter_column,
  //                                           const uint8_t* values_data, uint64_t values_data_len,
  //                                           const uint32_t* value_offsets, uint64_t value_count);
  csv_parser_finish_count_where_in: {
    args: ['ptr', 'u32', 'buffer', 'u64', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_write_count_where_starts_with(void* parser, const uint8_t* data, uint64_t len,
  //                                                   bool final, uint32_t filter_column,
  //                                                   const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_write_count_where_starts_with: {
    args: ['ptr', 'buffer', 'u64', 'bool', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // uint64_t csv_parser_finish_count_where_starts_with(void* parser, uint32_t filter_column,
  //                                                    const uint8_t* filter_value, uint64_t filter_value_len);
  csv_parser_finish_count_where_starts_with: {
    args: ['ptr', 'u32', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // void* csv_zip_reader_create(const char* path, const uint8_t* entry_name, uint64_t entry_name_len,
  //                             uint64_t maximum_output_size, uint32_t maximum_compression_ratio);
  csv_zip_reader_create: {
    args: ['cstring', 'buffer', 'u64', 'u64', 'u32'],
    returns: 'ptr',
  },
  // C signature:
  // void csv_zip_reader_destroy(void* reader);
  csv_zip_reader_destroy: {
    args: ['ptr'],
    returns: 'void',
  },
  // C signature:
  // uint64_t csv_zip_reader_read(void* reader, uint8_t* output, uint64_t output_capacity);
  csv_zip_reader_read: {
    args: ['ptr', 'buffer', 'u64'],
    returns: 'u64',
  },
  // C signature:
  // int csv_zip_reader_status(void* reader);
  csv_zip_reader_status: {
    args: ['ptr'],
    returns: 'int',
  },
  // C signature:
  // const char* csv_zip_reader_last_error(void* reader);
  csv_zip_reader_last_error: {
    args: ['ptr'],
    returns: 'cstring',
  },
  // C signature:
  // const char* csv_parser_last_error(void* parser);
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
