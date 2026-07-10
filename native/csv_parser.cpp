#include <hwy/highway.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#if defined(__ARM_NEON)
#include <arm_neon.h>
#endif
#if defined(__AVX2__)
#include <immintrin.h>
#endif

#if defined(_WIN32)
#define CSV_EXPORT extern "C" __declspec(dllexport)
#else
#define CSV_EXPORT extern "C" __attribute__((visibility("default")))
#endif

namespace csv_native {
namespace hn = hwy::HWY_NAMESPACE;

enum class csv_encoding : int {
  utf8 = 0,
  latin1 = 1,
};

enum class output_mode {
  batch,
  count,
  dictionary,
  group_by_count,
  column_stats,
  multi_column_stats,
};

enum class row_filter_kind : uint8_t {
  none = 0,
  equals = 1,
  in = 2,
  starts_with = 3,
};

struct row_filter {
  bool enabled = false;
  row_filter_kind kind = row_filter_kind::none;
  uint32_t column = 0;
  const uint8_t *value = nullptr;
  size_t value_len = 0;
  const uint8_t *values_data = nullptr;
  const uint32_t *value_offsets = nullptr;
  size_t value_count = 0;
};

struct csv_batch {
  std::vector<uint32_t> row_offsets{0};
  std::vector<uint32_t> field_offsets{0};
  std::string data;

  void reserve(size_t input_len, csv_encoding encoding) {
    const size_t data_capacity =
        encoding == csv_encoding::latin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    field_offsets.reserve((input_len / 6) + 32);
    row_offsets.reserve((input_len / 160) + 32);
  }

  void reserve_trusted(size_t input_len, csv_encoding encoding,
                       uint32_t fixed_columns, size_t rows_hint) {
    const size_t data_capacity =
        encoding == csv_encoding::latin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    const size_t fields_hint =
        rows_hint * static_cast<size_t>(fixed_columns) + 1;
    field_offsets.reserve(fields_hint);
    row_offsets.reserve(rows_hint + 1);
  }

  void reserve_fixed(size_t input_len, csv_encoding encoding,
                     uint32_t fixed_columns) {
    const size_t data_capacity =
        encoding == csv_encoding::latin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    const size_t rows_hint = (input_len / 160) + 32;
    field_offsets.reserve(rows_hint * static_cast<size_t>(fixed_columns) + 1);
    row_offsets.reserve(rows_hint + 1);
  }
};

struct csv_dictionary_batch {
  std::vector<uint32_t> ids;
  std::vector<uint32_t> dict_offsets{0};
  std::string dict_data;

  uint64_t row_count() const { return ids.size(); }

  uint64_t dict_count() const {
    return dict_offsets.empty() ? 0 : dict_offsets.size() - 1;
  }
};

struct csv_group_by_count_batch {
  std::vector<uint64_t> counts;
  std::vector<uint32_t> dict_offsets{0};
  std::string dict_data;
  uint64_t row_count = 0;

  uint64_t dict_count() const {
    return dict_offsets.empty() ? 0 : dict_offsets.size() - 1;
  }
};

struct csv_column_stats_batch {
  std::vector<uint32_t> ids;
  std::vector<uint64_t> counts;
  std::vector<uint32_t> dict_offsets{0};
  std::string dict_data;

  uint64_t row_count() const { return ids.size(); }

  uint64_t dict_count() const {
    return dict_offsets.empty() ? 0 : dict_offsets.size() - 1;
  }
};

struct csv_multi_column_stats_batch {
  std::vector<uint32_t> columns;
  std::vector<std::unique_ptr<csv_column_stats_batch>> batches;

  uint64_t column_count() const { return batches.size(); }
};

struct csv_split_offsets_batch {
  std::vector<uint64_t> offsets;
};

constexpr size_t npos = std::numeric_limits<size_t>::max();

uint64_t count_trusted_newlines(const uint8_t *data, size_t len) {
  if (data == nullptr || len == 0) {
    return 0;
  }

  uint64_t rows = 0;
  size_t i = 0;
#if defined(__AVX2__)
  const __m256i newline = _mm256_set1_epi8('\n');
  for (; i + 32 <= len; i += 32) {
    const __m256i bytes =
        _mm256_loadu_si256(reinterpret_cast<const __m256i *>(data + i));
    const __m256i matches = _mm256_cmpeq_epi8(bytes, newline);
    rows += static_cast<uint64_t>(__builtin_popcount(
        static_cast<unsigned>(_mm256_movemask_epi8(matches))));
  }
#elif defined(__ARM_NEON)
  const uint8x16_t newline = vdupq_n_u8('\n');
  for (; i + 16 <= len; i += 16) {
    const uint8x16_t bytes = vld1q_u8(data + i);
    const uint8x16_t matches = vceqq_u8(bytes, newline);
    rows += static_cast<uint64_t>(vaddvq_u8(vcntq_u8(matches)) >> 3);
  }
#endif
  for (; i < len; ++i) {
    rows += data[i] == '\n' ? 1 : 0;
  }
  if (data[len - 1] != '\n' && data[len - 1] != '\r') {
    ++rows;
  }
  return rows;
}

std::unique_ptr<csv_split_offsets_batch>
find_csv_safe_split_offsets(const char *path, size_t shard_count,
                            uint8_t delimiter) {
  if (path == nullptr || path[0] == '\0' || shard_count == 0 || delimiter == 0 ||
      delimiter == '\n' || delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }

  std::FILE *file = std::fopen(path, "rb");
  if (file == nullptr) {
    return nullptr;
  }

  if (std::fseek(file, 0, SEEK_END) != 0) {
    std::fclose(file);
    return nullptr;
  }
  const long size_long = std::ftell(file);
  if (size_long < 0) {
    std::fclose(file);
    return nullptr;
  }
  const uint64_t file_size = static_cast<uint64_t>(size_long);
  if (std::fseek(file, 0, SEEK_SET) != 0) {
    std::fclose(file);
    return nullptr;
  }

  auto batch = std::make_unique<csv_split_offsets_batch>();
  batch->offsets.reserve(shard_count + 1);
  batch->offsets.push_back(0);
  if (file_size == 0) {
    std::fclose(file);
    return batch;
  }

  std::vector<uint64_t> targets;
  targets.reserve(shard_count > 1 ? shard_count - 1 : 0);
  for (size_t shard_index = 1; shard_index < shard_count; ++shard_index) {
    targets.push_back((file_size * static_cast<uint64_t>(shard_index)) /
                      static_cast<uint64_t>(shard_count));
  }

  std::vector<uint8_t> buffer(8 * 1024 * 1024);
  size_t target_index = 0;
  uint64_t absolute = 0;
  bool in_quotes = false;
  bool at_field_start = true;
  bool pending_quote = false;
  bool previous_was_cr = false;

  while (true) {
    const size_t bytes_read = std::fread(buffer.data(), 1, buffer.size(), file);
    if (bytes_read == 0) {
      break;
    }

    size_t index = 0;
    while (index < bytes_read && target_index < targets.size()) {
      const uint8_t byte = buffer[index];

      if (pending_quote) {
        if (byte == '"') {
          pending_quote = false;
          at_field_start = false;
          ++index;
          ++absolute;
          continue;
        }
        pending_quote = false;
        in_quotes = false;
        continue;
      }

      if (in_quotes) {
        if (byte == '"') {
          pending_quote = true;
        }
        ++index;
        ++absolute;
        continue;
      }

      if (previous_was_cr && byte == '\n') {
        previous_was_cr = false;
        ++index;
        ++absolute;
        continue;
      }
      previous_was_cr = false;

      if (byte == '"' && at_field_start) {
        in_quotes = true;
        at_field_start = false;
        ++index;
        ++absolute;
        continue;
      }

      if (byte == '\n' || byte == '\r') {
        const uint64_t row_end = absolute + 1;
        previous_was_cr = byte == '\r';
        at_field_start = true;
        bool crossed_target = false;
        while (target_index < targets.size() && row_end >= targets[target_index]) {
          crossed_target = true;
          ++target_index;
        }
        if (crossed_target && row_end > batch->offsets.back()) {
          batch->offsets.push_back(row_end);
        }
        ++index;
        ++absolute;
        continue;
      }

      if (byte == delimiter) {
        at_field_start = true;
      } else {
        at_field_start = false;
      }

      ++index;
      ++absolute;
    }

    absolute += static_cast<uint64_t>(bytes_read - index);
    if (target_index >= targets.size()) {
      break;
    }
  }

  std::fclose(file);

  if (batch->offsets.back() != file_size) {
    batch->offsets.push_back(file_size);
  }
  return batch;
}

void append_latin1_scalar(std::string &out, const uint8_t *data, size_t len) {
  for (size_t i = 0; i < len; ++i) {
    const uint8_t byte = data[i];
    if (byte < 0x80) {
      out.push_back(static_cast<char>(byte));
    } else {
      out.push_back(static_cast<char>(0xC0 | (byte >> 6)));
      out.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
    }
  }
}

void append_latin1_scalar_byte(std::string &out, uint8_t byte) {
  if (byte < 0x80) {
    out.push_back(static_cast<char>(byte));
  } else {
    out.push_back(static_cast<char>(0xC0 | (byte >> 6)));
    out.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
  }
}

#if defined(__AVX2__)
constexpr size_t latin1_simd_block = 16;

bool latin1_simd_block_all_non_ascii(const uint8_t *data) {
  const __m128i bytes =
      _mm_loadu_si128(reinterpret_cast<const __m128i *>(data));
  return _mm_movemask_epi8(bytes) == 0xFFFF;
}

void append_latin1_simd_non_ascii_block(std::string &out, const uint8_t *data) {
  const __m128i bytes =
      _mm_loadu_si128(reinterpret_cast<const __m128i *>(data));
  const __m256i widened = _mm256_cvtepu8_epi16(bytes);
  const __m256i leading =
      _mm256_or_si256(_mm256_srli_epi16(widened, 6),
                      _mm256_set1_epi16(static_cast<int16_t>(0x00C0)));
  const __m256i trailing =
      _mm256_or_si256(_mm256_and_si256(widened, _mm256_set1_epi16(0x003F)),
                      _mm256_set1_epi16(static_cast<int16_t>(0x0080)));
  const __m256i packed =
      _mm256_or_si256(leading, _mm256_slli_epi16(trailing, 8));

  const size_t offset = out.size();
  out.resize(offset + latin1_simd_block * 2);
  _mm256_storeu_si256(reinterpret_cast<__m256i *>(out.data() + offset), packed);
}
#define CSV_NATIVE_LATIN1_SIMD_BLOCK 1
#elif defined(__ARM_NEON) && defined(__aarch64__)
constexpr size_t latin1_simd_block = 16;

bool latin1_simd_block_all_non_ascii(const uint8_t *data) {
  const uint8x16_t bytes = vld1q_u8(data);
  return vminvq_u8(bytes) >= 0x80;
}

uint16x8_t latin1_neon_encode_half(uint8x8_t bytes) {
  const uint16x8_t widened = vmovl_u8(bytes);
  const uint16x8_t leading =
      vorrq_u16(vshrq_n_u16(widened, 6), vdupq_n_u16(0x00C0));
  const uint16x8_t trailing =
      vorrq_u16(vandq_u16(widened, vdupq_n_u16(0x003F)), vdupq_n_u16(0x0080));
  return vorrq_u16(leading, vshlq_n_u16(trailing, 8));
}

void append_latin1_simd_non_ascii_block(std::string &out, const uint8_t *data) {
  const uint8x16_t bytes = vld1q_u8(data);
  const uint16x8_t low = latin1_neon_encode_half(vget_low_u8(bytes));
  const uint16x8_t high = latin1_neon_encode_half(vget_high_u8(bytes));

  const size_t offset = out.size();
  out.resize(offset + latin1_simd_block * 2);
  auto *dst = reinterpret_cast<uint8_t *>(out.data() + offset);
  vst1q_u8(dst, vreinterpretq_u8_u16(low));
  vst1q_u8(dst + 16, vreinterpretq_u8_u16(high));
}
#define CSV_NATIVE_LATIN1_SIMD_BLOCK 1
#endif

void append_latin1(std::string &out, const uint8_t *data, size_t len) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto limit = hn::Set(du8, static_cast<uint8_t>(0x80));
  const auto high_bit = hn::Set(du8, static_cast<uint8_t>(0x80));
  size_t i = 0;

  while (i < len) {
    while (i + lanes <= len) {
      const auto bytes = hn::LoadU(du8, data + i);
      if (!hn::AllTrue(du8, hn::Lt(bytes, limit))) {
        break;
      }
      out.append(reinterpret_cast<const char *>(data + i), lanes);
      i += lanes;
    }

#if defined(CSV_NATIVE_LATIN1_SIMD_BLOCK)
    if (i + latin1_simd_block <= len &&
        latin1_simd_block_all_non_ascii(data + i)) {
      append_latin1_simd_non_ascii_block(out, data + i);
      i += latin1_simd_block;
      continue;
    }
#endif

    if (i + lanes <= len) {
      const auto bytes = hn::LoadU(du8, data + i);
      const auto non_ascii = hn::Eq(hn::And(bytes, high_bit), high_bit);
      const intptr_t first_non_ascii = hn::FindFirstTrue(du8, non_ascii);
      if (first_non_ascii > 0) {
        out.append(reinterpret_cast<const char *>(data + i),
                   static_cast<size_t>(first_non_ascii));
        i += static_cast<size_t>(first_non_ascii);
        continue;
      }
      if (first_non_ascii == 0) {
        append_latin1_scalar_byte(out, data[i]);
        ++i;
        continue;
      }
    }

    append_latin1_scalar(out, data + i, len - i);
    break;
  }
}

size_t find_byte_simd(const uint8_t *data, size_t len, uint8_t needle) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto wanted = hn::Set(du8, needle);
  size_t i = 0;

  while (i + lanes <= len) {
    const auto bytes = hn::LoadU(du8, data + i);
    const intptr_t found = hn::FindFirstTrue(du8, hn::Eq(bytes, wanted));
    if (found >= 0) {
      return i + static_cast<size_t>(found);
    }
    i += lanes;
  }

  for (; i < len; ++i) {
    if (data[i] == needle) {
      return i;
    }
  }
  return npos;
}

size_t find_plain_special_simd(const uint8_t *data, size_t len,
                               uint8_t delimiter) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto delimiter_v = hn::Set(du8, delimiter);
  const auto lf_v = hn::Set(du8, static_cast<uint8_t>('\n'));
  const auto cr_v = hn::Set(du8, static_cast<uint8_t>('\r'));
  size_t i = 0;

  while (i + lanes <= len) {
    const auto bytes = hn::LoadU(du8, data + i);
    const auto delimiter_mask = hn::Eq(bytes, delimiter_v);
    const auto newline_mask = hn::Or(hn::Eq(bytes, lf_v), hn::Eq(bytes, cr_v));
    const intptr_t found =
        hn::FindFirstTrue(du8, hn::Or(delimiter_mask, newline_mask));
    if (found >= 0) {
      return i + static_cast<size_t>(found);
    }
    i += lanes;
  }

  for (; i < len; ++i) {
    const uint8_t byte = data[i];
    if (byte == delimiter || byte == '\n' || byte == '\r') {
      return i;
    }
  }
  return npos;
}

size_t find_strict_plain_special_simd(const uint8_t *data, size_t len,
                                      uint8_t delimiter) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto delimiter_v = hn::Set(du8, delimiter);
  const auto quote_v = hn::Set(du8, static_cast<uint8_t>('"'));
  const auto lf_v = hn::Set(du8, static_cast<uint8_t>('\n'));
  const auto cr_v = hn::Set(du8, static_cast<uint8_t>('\r'));
  size_t i = 0;

  while (i + lanes <= len) {
    const auto bytes = hn::LoadU(du8, data + i);
    const auto delimiter_mask = hn::Eq(bytes, delimiter_v);
    const auto quote_mask = hn::Eq(bytes, quote_v);
    const auto newline_mask = hn::Or(hn::Eq(bytes, lf_v), hn::Eq(bytes, cr_v));
    const intptr_t found = hn::FindFirstTrue(
        du8, hn::Or(hn::Or(delimiter_mask, quote_mask), newline_mask));
    if (found >= 0) {
      return i + static_cast<size_t>(found);
    }
    i += lanes;
  }

  for (; i < len; ++i) {
    const uint8_t byte = data[i];
    if (byte == delimiter || byte == '"' || byte == '\n' || byte == '\r') {
      return i;
    }
  }
  return npos;
}

bool is_quoted_field_terminator(uint8_t byte, uint8_t delimiter) {
  return byte == delimiter || byte == '\n' || byte == '\r';
}

uint64_t clear_mask_bits_through(uint64_t bits, size_t lane) {
  if (lane >= 63) {
    return 0;
  }
  return bits & (~0ull << (lane + 1));
}

class csv_parser {
public:
  csv_parser(csv_encoding encoding, uint8_t delimiter)
      : encoding_(encoding), delimiter_(delimiter) {}

  csv_batch *write_batch(const uint8_t *data, size_t len, bool final) {
    return write_batch_impl(data, len, final, false);
  }

  csv_batch *write_strict_batch(const uint8_t *data, size_t len, bool final) {
    return write_batch_impl(data, len, final, true);
  }

  csv_batch *write_fixed_batch(const uint8_t *data, size_t len, bool final,
                               uint32_t fixed_columns) {
    return write_fixed_batch_impl(data, len, final, fixed_columns, false);
  }

  csv_batch *write_strict_fixed_batch(const uint8_t *data, size_t len,
                                      bool final, uint32_t fixed_columns) {
    return write_fixed_batch_impl(data, len, final, fixed_columns, true);
  }

  csv_batch *write_fixed_batch_impl(const uint8_t *data, size_t len, bool final,
                                    uint32_t fixed_columns, bool strict) {
    if (fixed_columns == 0) {
      set_error("fixed columns must be greater than zero");
      return nullptr;
    }

    auto batch = std::make_unique<csv_batch>();
    batch->reserve_fixed(len, encoding_, fixed_columns);
    mode_ = output_mode::batch;
    batch_ = batch.get();
    configure(nullptr, 0, row_filter{});
    fixed_columns_enabled_ = true;
    fixed_columns_ = fixed_columns;
    strict_quote_syntax_ = strict;
    parse_failed_ = false;
    emitted_rows_ = 0;
    parse(data, len);
    if (!parse_failed_ && final) {
      finish_stream();
    }
    fixed_columns_enabled_ = false;
    fixed_columns_ = 0;
    strict_quote_syntax_ = false;
    batch_ = nullptr;
    if (parse_failed_) {
      return nullptr;
    }
    return batch.release();
  }

  csv_batch *write_trusted_fixed_batch(const uint8_t *data, size_t len,
                                       bool final, uint32_t fixed_columns) {
    return write_trusted_fixed_batch_impl(data, len, final, fixed_columns,
                                          false);
  }

  csv_batch *write_strict_trusted_fixed_batch(const uint8_t *data, size_t len,
                                              bool final,
                                              uint32_t fixed_columns) {
    return write_trusted_fixed_batch_impl(data, len, final, fixed_columns,
                                          true);
  }

  csv_batch *write_trusted_fixed_batch_impl(const uint8_t *data, size_t len,
                                            bool final, uint32_t fixed_columns,
                                            bool strict) {
    if (fixed_columns == 0) {
      set_error("trusted fixed columns must be greater than zero");
      return nullptr;
    }

    auto batch = std::make_unique<csv_batch>();
    batch->reserve_trusted(
        len, encoding_, fixed_columns,
        static_cast<size_t>(count_trusted_newlines(data, len)));
    mode_ = output_mode::batch;
    batch_ = batch.get();
    configure(nullptr, 0, row_filter{});
    emitted_rows_ = 0;
    if (!parse_trusted_fixed_rows(data, len, final, fixed_columns, strict)) {
      batch_ = nullptr;
      return nullptr;
    }
    batch_ = nullptr;
    return batch.release();
  }

  csv_batch *write_projected_batch(const uint8_t *data, size_t len, bool final,
                                   const uint32_t *selected_columns,
                                   size_t selected_columns_len,
                                   row_filter filter) {
    auto batch = std::make_unique<csv_batch>();
    batch->reserve(len, encoding_);
    mode_ = output_mode::batch;
    batch_ = batch.get();
    allow_direct_projection_ = true;
    configure(selected_columns, selected_columns_len, filter);
    emitted_rows_ = 0;
    parse(data, len);
    if (final) {
      finish_stream();
    } else {
      spill_unfinished_direct_projection_row();
      spill_unfinished_batch_row();
    }
    batch_ = nullptr;
    return batch.release();
  }

  csv_batch *finish_batch() { return write_batch(nullptr, 0, true); }

  csv_batch *finish_strict_batch() {
    return write_strict_batch(nullptr, 0, true);
  }

  csv_batch *finish_fixed_batch(uint32_t fixed_columns) {
    return write_fixed_batch(nullptr, 0, true, fixed_columns);
  }

  csv_batch *finish_strict_fixed_batch(uint32_t fixed_columns) {
    return write_strict_fixed_batch(nullptr, 0, true, fixed_columns);
  }

  csv_batch *finish_trusted_fixed_batch(uint32_t fixed_columns) {
    return write_trusted_fixed_batch(nullptr, 0, true, fixed_columns);
  }

  csv_batch *finish_strict_trusted_fixed_batch(uint32_t fixed_columns) {
    return write_strict_trusted_fixed_batch(nullptr, 0, true, fixed_columns);
  }

  csv_batch *finish_projected_batch(const uint32_t *selected_columns,
                                    size_t selected_columns_len,
                                    row_filter filter) {
    return write_projected_batch(nullptr, 0, true, selected_columns,
                                 selected_columns_len, filter);
  }

  csv_dictionary_batch *write_dictionary_batch(const uint8_t *data, size_t len,
                                               bool final, uint32_t column) {
    auto dictionary = std::make_unique<csv_dictionary_batch>();
    dictionary->ids.reserve((len / 160) + 32);
    mode_ = output_mode::dictionary;
    dictionary_batch_ = dictionary.get();
    dictionary_column_ = column;
    dictionary_hash_ids_.clear();
    dictionary_hash_ids_.reserve(128);
    dictionary_hash_collisions_.clear();
    emitted_rows_ = 0;
    parse(data, len);
    if (final) {
      finish_stream();
    }
    dictionary_batch_ = nullptr;

    return dictionary.release();
  }

  csv_dictionary_batch *finish_dictionary_batch(uint32_t column) {
    return write_dictionary_batch(nullptr, 0, true, column);
  }

  uint64_t write_group_by_count(const uint8_t *data, size_t len,
                                uint32_t column) {
    if (group_by_count_batch_owner_ == nullptr) {
      group_by_count_batch_owner_ =
          std::make_unique<csv_group_by_count_batch>();
      group_by_hash_ids_.clear();
      group_by_hash_ids_.reserve(128);
      group_by_hash_collisions_.clear();
      group_by_column_ = column;
    } else if (group_by_column_ != column) {
      set_error("groupBy count column changed during stream");
      return 0;
    }

    mode_ = output_mode::group_by_count;
    group_by_count_batch_ = group_by_count_batch_owner_.get();
    emitted_rows_ = 0;
    parse(data, len);
    return emitted_rows_;
  }

  csv_group_by_count_batch *finish_group_by_count(uint32_t column) {
    if (group_by_count_batch_owner_ == nullptr) {
      group_by_count_batch_owner_ =
          std::make_unique<csv_group_by_count_batch>();
      group_by_hash_ids_.clear();
      group_by_hash_ids_.reserve(128);
      group_by_hash_collisions_.clear();
      group_by_column_ = column;
    } else if (group_by_column_ != column) {
      set_error("groupBy count column changed during stream");
      return nullptr;
    }

    mode_ = output_mode::group_by_count;
    group_by_count_batch_ = group_by_count_batch_owner_.get();
    emitted_rows_ = 0;
    finish_stream();
    group_by_count_batch_ = nullptr;
    group_by_hash_ids_.clear();
    group_by_hash_collisions_.clear();
    return group_by_count_batch_owner_.release();
  }

  uint64_t write_column_stats(const uint8_t *data, size_t len,
                              uint32_t column) {
    if (column_stats_batch_owner_ == nullptr) {
      column_stats_batch_owner_ = std::make_unique<csv_column_stats_batch>();
      column_stats_hash_ids_.clear();
      column_stats_hash_ids_.reserve(128);
      column_stats_hash_collisions_.clear();
      column_stats_column_ = column;
    } else if (column_stats_column_ != column) {
      set_error("column stats column changed during stream");
      return 0;
    }

    mode_ = output_mode::column_stats;
    column_stats_batch_ = column_stats_batch_owner_.get();
    emitted_rows_ = 0;
    parse(data, len);
    return emitted_rows_;
  }

  csv_column_stats_batch *finish_column_stats(uint32_t column) {
    if (column_stats_batch_owner_ == nullptr) {
      column_stats_batch_owner_ = std::make_unique<csv_column_stats_batch>();
      column_stats_hash_ids_.clear();
      column_stats_hash_ids_.reserve(128);
      column_stats_hash_collisions_.clear();
      column_stats_column_ = column;
    } else if (column_stats_column_ != column) {
      set_error("column stats column changed during stream");
      return nullptr;
    }

    mode_ = output_mode::column_stats;
    column_stats_batch_ = column_stats_batch_owner_.get();
    emitted_rows_ = 0;
    finish_stream();
    column_stats_batch_ = nullptr;
    column_stats_hash_ids_.clear();
    column_stats_hash_collisions_.clear();
    return column_stats_batch_owner_.release();
  }

  uint64_t write_multi_column_stats(const uint8_t *data, size_t len,
                                    const uint32_t *columns,
                                    size_t columns_len) {
    if (!ensure_multi_column_stats(columns, columns_len, len)) {
      return 0;
    }

    mode_ = output_mode::multi_column_stats;
    emitted_rows_ = 0;
    parse(data, len);
    return emitted_rows_;
  }

  csv_multi_column_stats_batch *
  finish_multi_column_stats(const uint32_t *columns, size_t columns_len) {
    if (!ensure_multi_column_stats(columns, columns_len, 0)) {
      return nullptr;
    }

    mode_ = output_mode::multi_column_stats;
    emitted_rows_ = 0;
    finish_stream();
    multi_column_stats_indexes_.clear();
    multi_column_stats_hash_ids_.clear();
    multi_column_stats_hash_collisions_.clear();
    multi_column_stats_row_ids_.clear();
    multi_column_stats_row_seen_.clear();
    return multi_column_stats_batch_owner_.release();
  }

  uint64_t write_count(const uint8_t *data, size_t len, bool final) {
    return write_count_where(data, len, final, row_filter{});
  }

  uint64_t write_count_where_equals(const uint8_t *data, size_t len, bool final,
                                    row_filter filter) {
    filter.kind =
        filter.enabled ? row_filter_kind::equals : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where_in(const uint8_t *data, size_t len, bool final,
                                row_filter filter) {
    filter.kind = filter.enabled ? row_filter_kind::in : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where_starts_with(const uint8_t *data, size_t len,
                                         bool final, row_filter filter) {
    filter.kind =
        filter.enabled ? row_filter_kind::starts_with : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where(const uint8_t *data, size_t len, bool final,
                             row_filter filter) {
    mode_ = output_mode::count;
    configure(nullptr, 0, filter);
    emitted_rows_ = 0;
    parse(data, len);
    if (final) {
      finish_stream();
    }
    return emitted_rows_;
  }

  uint64_t finish_count() { return write_count(nullptr, 0, true); }

  uint64_t finish_count_where_equals(row_filter filter) {
    return write_count_where_equals(nullptr, 0, true, filter);
  }

  uint64_t finish_count_where_in(row_filter filter) {
    return write_count_where_in(nullptr, 0, true, filter);
  }

  uint64_t finish_count_where_starts_with(row_filter filter) {
    return write_count_where_starts_with(nullptr, 0, true, filter);
  }

  void reset() {
    field_.clear();
    trusted_row_buffer_.clear();
    row_fields_.clear();
    projected_fields_.clear();
    error_.clear();
    batch_ = nullptr;
    dictionary_batch_ = nullptr;
    group_by_count_batch_ = nullptr;
    group_by_count_batch_owner_.reset();
    column_stats_batch_ = nullptr;
    column_stats_batch_owner_.reset();
    multi_column_stats_batch_owner_.reset();
    dictionary_hash_ids_.clear();
    dictionary_hash_collisions_.clear();
    group_by_hash_ids_.clear();
    group_by_hash_collisions_.clear();
    column_stats_hash_ids_.clear();
    column_stats_hash_collisions_.clear();
    multi_column_stats_indexes_.clear();
    multi_column_stats_hash_ids_.clear();
    multi_column_stats_hash_collisions_.clear();
    multi_column_stats_row_ids_.clear();
    multi_column_stats_row_seen_.clear();
    selected_columns_ = nullptr;
    selected_columns_len_ = 0;
    projection_enabled_ = false;
    fixed_columns_enabled_ = false;
    fixed_columns_ = 0;
    parse_failed_ = false;
    strict_expected_columns_ = 0;
    strict_expected_columns_seen_ = false;
    filter_ = row_filter{};
    in_quotes_ = false;
    pending_quote_ = false;
    at_field_start_ = true;
    saw_row_data_ = false;
    previous_was_cr_ = false;
    current_column_ = 0;
    row_filter_seen_ = false;
    row_filter_matched_ = false;
    dictionary_column_ = 0;
    dictionary_row_seen_ = false;
    group_by_column_ = 0;
    group_by_row_id_ = 0;
    group_by_row_seen_ = false;
    column_stats_column_ = 0;
    column_stats_row_id_ = 0;
    column_stats_row_seen_ = false;
    emitted_rows_ = 0;
    field_in_arena_ = false;
    complete_quoted_field_has_escape_ = false;
    direct_projection_ = false;
    allow_direct_projection_ = false;
    deferred_batch_row_ = false;
    direct_projection_row_started_ = false;
    direct_projection_data_start_ = 0;
    direct_projection_field_offsets_start_ = 0;
    direct_projection_carry_count_ = 0;
  }

  const char *last_error() const {
    return error_.empty() ? "" : error_.c_str();
  }

  void set_error(const char *value) { error_ = value; }

private:
  csv_batch *write_batch_impl(const uint8_t *data, size_t len, bool final,
                              bool strict) {
    auto batch = std::make_unique<csv_batch>();
    batch->reserve(len, encoding_);
    mode_ = output_mode::batch;
    batch_ = batch.get();
    allow_direct_projection_ = final && !saw_row_data_;
    configure(nullptr, 0, row_filter{});
    strict_quote_syntax_ = strict;
    parse_failed_ = false;
    emitted_rows_ = 0;
    parse(data, len);
    if (final) {
      finish_stream();
    } else {
      spill_unfinished_batch_row();
    }
    strict_quote_syntax_ = false;
    batch_ = nullptr;
    if (parse_failed_) {
      return nullptr;
    }
    return batch.release();
  }

  void configure(const uint32_t *selected_columns, size_t selected_columns_len,
                 row_filter filter) {
    selected_columns_ = selected_columns;
    selected_columns_len_ = selected_columns_len;
    projection_enabled_ = selected_columns != nullptr;
    filter_ = filter;
    selected_column_counts_.clear();
    selected_column_outputs_.clear();

    if (projection_enabled_ &&
        projected_fields_.size() != selected_columns_len_) {
      projected_fields_.assign(selected_columns_len_, std::string{});
    }
    if (projection_enabled_) {
      uint32_t max_column = 0;
      for (size_t i = 0; i < selected_columns_len_; ++i) {
        if (selected_columns_[i] > max_column) {
          max_column = selected_columns_[i];
        }
      }
      selected_column_counts_.assign(static_cast<size_t>(max_column) + 1, 0);
      selected_column_outputs_.assign(static_cast<size_t>(max_column) + 1,
                                      std::vector<uint32_t>{});
      for (size_t i = 0; i < selected_columns_len_; ++i) {
        const uint32_t column = selected_columns_[i];
        ++selected_column_counts_[column];
        selected_column_outputs_[column].push_back(checked_u32(i));
      }
    }
    direct_projection_ = can_use_direct_projection();
    restore_direct_projection_row();
  }

  bool ensure_multi_column_stats(const uint32_t *columns, size_t columns_len,
                                 size_t input_len) {
    if (columns == nullptr && columns_len != 0) {
      set_error("multi-column stats columns are null");
      return false;
    }

    if (multi_column_stats_batch_owner_ != nullptr) {
      if (multi_column_stats_batch_owner_->columns.size() != columns_len) {
        set_error("multi-column stats columns changed during stream");
        return false;
      }
      for (size_t index = 0; index < columns_len; ++index) {
        if (multi_column_stats_batch_owner_->columns[index] != columns[index]) {
          set_error("multi-column stats columns changed during stream");
          return false;
        }
      }
      return true;
    }

    multi_column_stats_batch_owner_ =
        std::make_unique<csv_multi_column_stats_batch>();
    if (columns_len != 0) {
      multi_column_stats_batch_owner_->columns.assign(columns,
                                                      columns + columns_len);
    }
    multi_column_stats_batch_owner_->batches.reserve(columns_len);
    multi_column_stats_indexes_.clear();
    multi_column_stats_hash_ids_.clear();
    multi_column_stats_hash_ids_.resize(columns_len);
    multi_column_stats_hash_collisions_.clear();
    multi_column_stats_hash_collisions_.resize(columns_len);
    multi_column_stats_row_ids_.assign(columns_len, 0);
    multi_column_stats_row_seen_.assign(columns_len, false);

    for (size_t index = 0; index < columns_len; ++index) {
      auto batch = std::make_unique<csv_column_stats_batch>();
      batch->ids.reserve((input_len / 160) + 32);
      multi_column_stats_batch_owner_->batches.push_back(std::move(batch));
      multi_column_stats_indexes_[columns[index]].push_back(index);
      multi_column_stats_hash_ids_[index].reserve(128);
    }

    return true;
  }

  void parse(const uint8_t *data, size_t len) {
    if (data == nullptr || len == 0) {
      return;
    }

    if (mode_ == output_mode::count && !filter_.enabled) {
      parse_count_only(data, len);
      return;
    }

    size_t i = 0;
    while (i < len) {
      if (in_quotes_) {
        if (pending_quote_) {
          if (data[i] == '"') {
            append_decoded_byte('"');
            pending_quote_ = false;
            saw_row_data_ = true;
            at_field_start_ = false;
            ++i;
            continue;
          }
          if (strict_quote_syntax_ &&
              !is_quoted_field_terminator(data[i], delimiter_)) {
            fail_parse("strict CSV quote syntax error: unescaped quote in "
                       "quoted field");
            return;
          }
          pending_quote_ = false;
          in_quotes_ = false;
          continue;
        }

        const size_t quote = find_byte_simd(data + i, len - i, '"');
        const size_t span = quote == npos ? len - i : quote;
        append_decoded_span(data + i, span);
        i += span;

        if (i < len && data[i] == '"') {
          pending_quote_ = true;
          ++i;
        }
        continue;
      }

      const uint8_t byte = data[i];
      if (previous_was_cr_ && byte == '\n') {
        previous_was_cr_ = false;
        ++i;
        continue;
      }
      previous_was_cr_ = false;

      if (byte == delimiter_) {
        finish_field();
        saw_row_data_ = true;
        ++i;
        continue;
      }

      if (byte == '\n' || byte == '\r') {
        finish_row();
        previous_was_cr_ = byte == '\r';
        ++i;
        continue;
      }

      if (byte == '"' && at_field_start_) {
        const size_t close_quote =
            find_complete_quoted_field_close(data + i, len - i);
        if (close_quote != npos) {
          append_complete_quoted_field(data + i, close_quote);
          const size_t terminator_index = i + close_quote + 1;
          const uint8_t terminator = data[terminator_index];
          if (terminator == delimiter_) {
            finish_field();
            saw_row_data_ = true;
            i = terminator_index + 1;
            continue;
          }
          if (terminator == '\n' || terminator == '\r') {
            finish_row();
            previous_was_cr_ = terminator == '\r';
            i = terminator_index + 1;
            continue;
          }
          i = terminator_index;
          continue;
        }

        in_quotes_ = true;
        at_field_start_ = false;
        saw_row_data_ = true;
        ++i;
        continue;
      }

      if (strict_quote_syntax_ && byte == '"') {
        fail_parse(
            "strict CSV quote syntax error: unescaped quote in unquoted field");
        return;
      }

      const size_t span = find_plain_span(data + i, len - i);
      append_plain_span(data + i, span, len - i);
      i += span;
    }
  }

  void parse_count_only(const uint8_t *data, size_t len) {
    size_t i = 0;
    while (i < len) {
      if (in_quotes_) {
        if (pending_quote_) {
          if (data[i] == '"') {
            pending_quote_ = false;
            saw_row_data_ = true;
            at_field_start_ = false;
            ++i;
            continue;
          }
          pending_quote_ = false;
          in_quotes_ = false;
          continue;
        }

        const size_t quote = find_byte_simd(data + i, len - i, '"');
        saw_row_data_ = true;
        at_field_start_ = false;
        if (quote == npos) {
          return;
        }
        i += quote + 1;
        pending_quote_ = true;
        continue;
      }

      const uint8_t byte = data[i];
      if (previous_was_cr_ && byte == '\n') {
        previous_was_cr_ = false;
        ++i;
        continue;
      }
      previous_was_cr_ = false;

      if (byte == '"' && at_field_start_) {
        in_quotes_ = true;
        pending_quote_ = false;
        saw_row_data_ = true;
        at_field_start_ = false;
        ++i;
        continue;
      }

      if (byte == '\n' || byte == '\r') {
        ++emitted_rows_;
        previous_was_cr_ = byte == '\r';
        saw_row_data_ = false;
        at_field_start_ = true;
        current_column_ = 0;
        ++i;
        continue;
      }

      if (byte == delimiter_) {
        saw_row_data_ = true;
        at_field_start_ = true;
        ++i;
        continue;
      }

      const size_t span = find_plain_span(data + i, len - i);
      saw_row_data_ = true;
      at_field_start_ = false;
      i += span;
    }
  }

  bool parse_trusted_fixed_rows(const uint8_t *data, size_t len, bool final,
                                uint32_t fixed_columns, bool strict) {
    size_t row_start = 0;
    while (row_start < len) {
      const size_t newline = find_byte_simd(data + row_start, len - row_start,
                                            static_cast<uint8_t>('\n'));
      if (newline == npos) {
        break;
      }

      size_t row_len = newline;
      if (row_len != 0 && data[row_start + row_len - 1] == '\r') {
        --row_len;
      }

      if (!trusted_row_buffer_.empty()) {
        trusted_row_buffer_.append(
            reinterpret_cast<const char *>(data + row_start), row_len);
        if (!parse_trusted_fixed_buffered_row(fixed_columns, strict)) {
          return false;
        }
      } else if (!parse_trusted_fixed_row(data + row_start, row_len,
                                          fixed_columns, strict)) {
        return false;
      }

      row_start += newline + 1;
    }

    if (row_start < len) {
      trusted_row_buffer_.append(
          reinterpret_cast<const char *>(data + row_start), len - row_start);
    }

    if (final && !trusted_row_buffer_.empty()) {
      if (!parse_trusted_fixed_buffered_row(fixed_columns, strict)) {
        return false;
      }
    }

    return true;
  }

  bool parse_trusted_fixed_buffered_row(uint32_t fixed_columns, bool strict) {
    size_t row_len = trusted_row_buffer_.size();
    if (row_len != 0 && trusted_row_buffer_[row_len - 1] == '\r') {
      --row_len;
    }
    const bool ok = parse_trusted_fixed_row(
        reinterpret_cast<const uint8_t *>(trusted_row_buffer_.data()), row_len,
        fixed_columns, strict);
    trusted_row_buffer_.clear();
    return ok;
  }

  bool parse_trusted_fixed_row(const uint8_t *row, size_t len,
                               uint32_t fixed_columns, bool strict) {
    if (len == 0) {
      return true;
    }
    if (batch_ == nullptr) {
      set_error("trusted fixed batch is null");
      return false;
    }

    uint32_t parsed_columns = 0;
    size_t i = 0;
    while (true) {
      if (i < len && row[i] == '"') {
        ++i;
        bool closed = false;
        while (i < len) {
          const size_t quote =
              find_byte_simd(row + i, len - i, static_cast<uint8_t>('"'));
          const size_t span = quote == npos ? len - i : quote;
          append_trusted_fixed_span(row + i, span);
          i += span;
          if (quote == npos) {
            break;
          }
          ++i;
          if (i < len && row[i] == '"') {
            append_trusted_fixed_byte(static_cast<uint8_t>('"'));
            ++i;
            continue;
          }
          closed = true;
          break;
        }

        if (!closed) {
          set_error("trusted fixed quoted field is not closed before row end");
          return false;
        }
        if (strict && i < len && row[i] != delimiter_) {
          set_error(
              "strict CSV quote syntax error: unescaped quote in quoted field");
          return false;
        }
        while (i < len && row[i] != delimiter_) {
          ++i;
        }
      } else {
        const size_t special =
            strict ? find_trusted_fixed_unquoted_special(row + i, len - i)
                   : find_byte_simd(row + i, len - i, delimiter_);
        const size_t span = special == npos ? len - i : special;
        append_trusted_fixed_span(row + i, span);
        i += span;
        if (strict && i < len && row[i] == '"') {
          set_error("strict CSV quote syntax error: unescaped quote in "
                    "unquoted field");
          return false;
        }
      }

      finish_trusted_fixed_field();
      ++parsed_columns;

      if (i >= len) {
        break;
      }

      if (row[i] != delimiter_) {
        set_error("trusted fixed row parser stopped before delimiter");
        return false;
      }
      ++i;

      if (i == len) {
        finish_trusted_fixed_field();
        ++parsed_columns;
        break;
      }
    }

    if (parsed_columns != fixed_columns) {
      set_error("trusted fixed row column count mismatch");
      return false;
    }

    finish_batch_row();
    ++emitted_rows_;
    return true;
  }

  void append_trusted_fixed_byte(uint8_t byte) {
    append_trusted_fixed_span(&byte, 1);
  }

  void append_trusted_fixed_span(const uint8_t *data, size_t len) {
    if (len == 0) {
      return;
    }
    if (encoding_ == csv_encoding::utf8) {
      batch_->data.append(reinterpret_cast<const char *>(data), len);
      return;
    }
    append_latin1(batch_->data, data, len);
  }

  void finish_trusted_fixed_field() {
    batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
  }

  size_t find_trusted_fixed_unquoted_special(const uint8_t *data,
                                             size_t len) const {
    const size_t found = find_strict_plain_special_simd(data, len, delimiter_);
    return found == npos || data[found] == '\n' || data[found] == '\r' ? npos
                                                                       : found;
  }

  size_t find_plain_span(const uint8_t *data, size_t len) const {
    const size_t found =
        strict_quote_syntax_
            ? find_strict_plain_special_simd(data, len, delimiter_)
            : find_plain_special_simd(data, len, delimiter_);
    return found == npos ? len : found;
  }

  size_t find_complete_quoted_field_close(const uint8_t *data,
                                          size_t len) const {
    complete_quoted_field_has_escape_ = false;

    const hn::CappedTag<uint8_t, 64> du8;
    const size_t lanes = hn::Lanes(du8);
    const auto quote_v = hn::Set(du8, static_cast<uint8_t>('"'));
    size_t i = 1;

    while (i + lanes <= len) {
      const auto bytes = hn::LoadU(du8, data + i);
      uint64_t quote_bits = hn::BitsFromMask(du8, hn::Eq(bytes, quote_v));
      if (quote_bits == 0) {
        i += lanes;
        continue;
      }

      while (quote_bits != 0) {
        const size_t lane = hwy::Num0BitsBelowLS1Bit_Nonzero64(quote_bits);
        const size_t quote = i + lane;
        if (quote + 1 >= len) {
          return npos;
        }

        const uint8_t next = data[quote + 1];
        if (next == '"') {
          complete_quoted_field_has_escape_ = true;
          if (quote + 2 > i + lanes) {
            i = quote + 2;
            goto continue_outer;
          }
          quote_bits = clear_mask_bits_through(quote_bits, lane + 1);
          continue;
        }
        if (is_quoted_field_terminator(next, delimiter_)) {
          return quote;
        }
        return npos;
      }

      i += lanes;
    continue_outer:
      continue;
    }

    while (i < len) {
      if (data[i] != '"') {
        ++i;
        continue;
      }

      if (i + 1 >= len) {
        return npos;
      }

      const uint8_t next = data[i + 1];
      if (next == '"') {
        complete_quoted_field_has_escape_ = true;
        i += 2;
        continue;
      }
      if (is_quoted_field_terminator(next, delimiter_)) {
        return i;
      }
      return npos;
    }

    return npos;
  }

  void append_decoded_byte(uint8_t byte) { append_decoded_span(&byte, 1); }

  void append_plain_span(const uint8_t *data, size_t len, size_t remaining) {
    if (can_append_complete_plain_field_to_arena(len, remaining)) {
      append_utf8_span_to_arena(data, len);
      return;
    }

    append_decoded_span(data, len);
  }

  void append_decoded_span(const uint8_t *data, size_t len) {
    if (len == 0) {
      return;
    }
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!should_capture_current_field()) {
      return;
    }

    if (encoding_ == csv_encoding::utf8) {
      field_.append(reinterpret_cast<const char *>(data), len);
      return;
    }

    append_latin1(field_, data, len);
  }

  bool can_append_complete_plain_field_to_arena(size_t len,
                                                size_t remaining) const {
    return mode_ == output_mode::batch && encoding_ == csv_encoding::utf8 &&
           batch_ != nullptr &&
           (!use_deferred_rows() || can_append_direct_projection_to_arena()) &&
           at_field_start_ && field_.empty() && !field_in_arena_ &&
           len < remaining;
  }

  bool can_append_direct_projection_to_arena() const {
    return direct_projection_ && should_store_current_field() &&
           (!filter_.enabled || current_column_ != filter_.column);
  }

  void append_utf8_span_to_arena(const uint8_t *data, size_t len) {
    saw_row_data_ = true;
    at_field_start_ = false;
    field_in_arena_ = true;
    ensure_direct_projection_row_started();
    if (len != 0) {
      batch_->data.append(reinterpret_cast<const char *>(data), len);
    }
  }

  void append_complete_quoted_field(const uint8_t *data, size_t close_quote) {
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!should_capture_current_field()) {
      return;
    }

    if (encoding_ == csv_encoding::utf8 && mode_ == output_mode::batch &&
        batch_ != nullptr &&
        (!use_deferred_rows() || can_append_direct_projection_to_arena()) &&
        field_.empty() && !field_in_arena_) {
      append_quoted_field_to_arena(data, close_quote);
      return;
    }

    append_quoted_field_to_field_buffer(data, close_quote);
  }

  void append_quoted_field_to_arena(const uint8_t *data, size_t close_quote) {
    field_in_arena_ = true;
    ensure_direct_projection_row_started();
    if (!complete_quoted_field_has_escape_) {
      batch_->data.append(reinterpret_cast<const char *>(data + 1),
                          close_quote - 1);
      return;
    }

    size_t segment_start = 1;
    for (size_t i = 1; i < close_quote; ++i) {
      if (data[i] == '"' && i + 1 < close_quote && data[i + 1] == '"') {
        batch_->data.append(
            reinterpret_cast<const char *>(data + segment_start),
            i - segment_start);
        batch_->data.push_back('"');
        ++i;
        segment_start = i + 1;
      }
    }
    batch_->data.append(reinterpret_cast<const char *>(data + segment_start),
                        close_quote - segment_start);
  }

  void append_quoted_field_to_field_buffer(const uint8_t *data,
                                           size_t close_quote) {
    if (!complete_quoted_field_has_escape_) {
      append_decoded_span(data + 1, close_quote - 1);
      return;
    }

    size_t segment_start = 1;
    for (size_t i = 1; i < close_quote; ++i) {
      if (data[i] == '"' && i + 1 < close_quote && data[i + 1] == '"') {
        append_decoded_span(data + segment_start, i - segment_start);
        append_decoded_byte('"');
        ++i;
        segment_start = i + 1;
      }
    }
    append_decoded_span(data + segment_start, close_quote - segment_start);
  }

  void finish_field() {
    if (use_deferred_rows()) {
      finish_deferred_field();
    } else if (mode_ == output_mode::dictionary) {
      finish_dictionary_field();
    } else if (mode_ == output_mode::group_by_count) {
      finish_group_by_count_field();
    } else if (mode_ == output_mode::column_stats) {
      finish_column_stats_field();
    } else if (mode_ == output_mode::multi_column_stats) {
      finish_multi_column_stats_field();
    } else if (mode_ == output_mode::batch && batch_ != nullptr) {
      if (!field_in_arena_) {
        batch_->data.append(field_);
      }
      batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
    }
    field_.clear();
    field_in_arena_ = false;
    at_field_start_ = true;
    ++current_column_;
  }

  void finish_row() {
    if (!saw_row_data_) {
      at_field_start_ = true;
    }

    finish_field();
    const bool emit_row =
        !filter_.enabled || (row_filter_seen_ && row_filter_matched_);
    if (mode_ == output_mode::batch && emit_row) {
      if (direct_projection_) {
        finish_batch_row();
      } else if (use_deferred_rows()) {
        commit_deferred_batch_row();
      } else {
        finish_batch_row();
      }
    } else if (mode_ == output_mode::batch && direct_projection_) {
      rollback_direct_projection_row();
    }
    if (mode_ == output_mode::dictionary) {
      finish_dictionary_row();
    }
    if (mode_ == output_mode::group_by_count) {
      finish_group_by_count_row();
    }
    if (mode_ == output_mode::column_stats) {
      finish_column_stats_row();
    }
    if (mode_ == output_mode::multi_column_stats) {
      finish_multi_column_stats_row();
    }
    if (emit_row) {
      ++emitted_rows_;
    }
    reset_row_state();
    saw_row_data_ = false;
    at_field_start_ = true;
  }

  bool use_deferred_rows() const {
    return projection_enabled_ || filter_.enabled || fixed_columns_enabled_ ||
           deferred_batch_row_;
  }

  bool should_capture_current_field() const {
    if (mode_ == output_mode::count) {
      return filter_.enabled && current_column_ == filter_.column;
    }

    if (mode_ == output_mode::dictionary) {
      return current_column_ == dictionary_column_;
    }

    if (mode_ == output_mode::group_by_count) {
      return current_column_ == group_by_column_;
    }

    if (mode_ == output_mode::column_stats) {
      return current_column_ == column_stats_column_;
    }

    if (mode_ == output_mode::multi_column_stats) {
      return multi_column_stats_indexes_.find(current_column_) !=
             multi_column_stats_indexes_.end();
    }

    if (!use_deferred_rows()) {
      return true;
    }

    return should_store_current_field() ||
           (filter_.enabled && current_column_ == filter_.column);
  }

  bool should_store_current_field() const {
    return !projection_enabled_ || selected_output_count(current_column_) > 0;
  }

  bool can_use_direct_projection() const {
    if (!allow_direct_projection_ || mode_ != output_mode::batch ||
        !projection_enabled_ || selected_columns_len_ == 0) {
      return false;
    }

    uint32_t previous = 0;
    for (size_t i = 0; i < selected_columns_len_; ++i) {
      const uint32_t column = selected_columns_[i];
      if (i != 0 && column <= previous) {
        return false;
      }
      previous = column;
    }
    return true;
  }

  size_t selected_output_count(uint32_t column) const {
    return column < selected_column_counts_.size()
               ? selected_column_counts_[column]
               : 0;
  }

  void finish_deferred_field() {
    if (direct_projection_) {
      finish_direct_projection_field();
      return;
    }

    if (filter_.enabled && current_column_ == filter_.column) {
      row_filter_seen_ = true;
      row_filter_matched_ = field_matches_filter();
    }

    if (mode_ != output_mode::batch) {
      return;
    }

    if (!projection_enabled_) {
      row_fields_.push_back(field_);
      return;
    }

    if (current_column_ >= selected_column_outputs_.size()) {
      return;
    }

    for (const uint32_t output_index :
         selected_column_outputs_[current_column_]) {
      projected_fields_[output_index] = field_;
    }
  }

  void finish_direct_projection_field() {
    if (filter_.enabled && current_column_ == filter_.column) {
      row_filter_seen_ = true;
      row_filter_matched_ = field_matches_filter();
    }

    if (batch_ == nullptr || !should_store_current_field()) {
      return;
    }

    ensure_direct_projection_row_started();

    if (!field_in_arena_) {
      batch_->data.append(field_);
    }
    batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
  }

  void ensure_direct_projection_row_started() {
    if (!direct_projection_ || batch_ == nullptr ||
        direct_projection_row_started_) {
      return;
    }
    direct_projection_row_started_ = true;
    direct_projection_data_start_ = batch_->data.size();
    direct_projection_field_offsets_start_ = batch_->field_offsets.size();
  }

  void rollback_direct_projection_row() {
    if (batch_ == nullptr || !direct_projection_row_started_) {
      return;
    }
    batch_->data.resize(direct_projection_data_start_);
    batch_->field_offsets.resize(direct_projection_field_offsets_start_);
  }

  void restore_direct_projection_row() {
    if (!direct_projection_ || batch_ == nullptr ||
        direct_projection_carry_count_ == 0) {
      return;
    }

    direct_projection_row_started_ = true;
    direct_projection_data_start_ = batch_->data.size();
    direct_projection_field_offsets_start_ = batch_->field_offsets.size();
    for (size_t index = 0; index < direct_projection_carry_count_; ++index) {
      batch_->data.append(projected_fields_[index]);
      batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
    }
  }

  bool field_matches_filter() const {
    switch (filter_.kind) {
    case row_filter_kind::equals:
      return field_equals_filter(filter_.value, filter_.value_len);
    case row_filter_kind::in:
      return field_in_filter();
    case row_filter_kind::starts_with:
      return field_starts_with_filter();
    case row_filter_kind::none:
      return true;
    }
    return false;
  }

  bool field_equals_filter(const uint8_t *value, size_t value_len) const {
    if (field_.size() != value_len) {
      return false;
    }
    if (value_len == 0) {
      return true;
    }
    return std::memcmp(field_.data(), value, value_len) == 0;
  }

  bool field_in_filter() const {
    if (filter_.value_offsets == nullptr || filter_.values_data == nullptr) {
      return false;
    }
    for (size_t index = 0; index < filter_.value_count; ++index) {
      const uint32_t start = filter_.value_offsets[index];
      const uint32_t end = filter_.value_offsets[index + 1];
      if (field_equals_filter(filter_.values_data + start, end - start)) {
        return true;
      }
    }
    return false;
  }

  bool field_starts_with_filter() const {
    if (field_.size() < filter_.value_len) {
      return false;
    }
    if (filter_.value_len == 0) {
      return true;
    }
    return std::memcmp(field_.data(), filter_.value, filter_.value_len) == 0;
  }

  void finish_dictionary_field() {
    if (dictionary_batch_ != nullptr && current_column_ == dictionary_column_) {
      dictionary_row_seen_ = true;
      dictionary_row_id_ = intern_dictionary_value(
          *dictionary_batch_, dictionary_hash_ids_, dictionary_hash_collisions_,
          field_.data(), field_.size());
    }
  }

  void finish_dictionary_row() {
    if (dictionary_batch_ == nullptr) {
      return;
    }
    if (!dictionary_row_seen_) {
      dictionary_row_id_ =
          intern_dictionary_value(*dictionary_batch_, dictionary_hash_ids_,
                                  dictionary_hash_collisions_, nullptr, 0);
    }
    dictionary_batch_->ids.push_back(dictionary_row_id_);
  }

  void finish_group_by_count_field() {
    if (group_by_count_batch_ != nullptr &&
        current_column_ == group_by_column_) {
      group_by_row_seen_ = true;
      group_by_row_id_ = intern_group_by_count_value(
          *group_by_count_batch_, group_by_hash_ids_, group_by_hash_collisions_,
          field_.data(), field_.size());
    }
  }

  void finish_group_by_count_row() {
    if (group_by_count_batch_ == nullptr) {
      return;
    }
    if (!group_by_row_seen_) {
      group_by_row_id_ = intern_group_by_count_value(
          *group_by_count_batch_, group_by_hash_ids_, group_by_hash_collisions_,
          nullptr, 0);
    }
    ++group_by_count_batch_->counts[group_by_row_id_];
    ++group_by_count_batch_->row_count;
  }

  void finish_column_stats_field() {
    if (column_stats_batch_ != nullptr &&
        current_column_ == column_stats_column_) {
      column_stats_row_seen_ = true;
      column_stats_row_id_ = intern_column_stats_value(
          *column_stats_batch_, column_stats_hash_ids_,
          column_stats_hash_collisions_, field_.data(), field_.size());
    }
  }

  void finish_column_stats_row() {
    if (column_stats_batch_ == nullptr) {
      return;
    }
    if (!column_stats_row_seen_) {
      column_stats_row_id_ = intern_column_stats_value(
          *column_stats_batch_, column_stats_hash_ids_,
          column_stats_hash_collisions_, nullptr, 0);
    }
    column_stats_batch_->ids.push_back(column_stats_row_id_);
    ++column_stats_batch_->counts[column_stats_row_id_];
  }

  void finish_multi_column_stats_field() {
    if (multi_column_stats_batch_owner_ == nullptr) {
      return;
    }

    const auto found = multi_column_stats_indexes_.find(current_column_);
    if (found == multi_column_stats_indexes_.end()) {
      return;
    }

    for (const size_t index : found->second) {
      multi_column_stats_row_seen_[index] = true;
      multi_column_stats_row_ids_[index] = intern_column_stats_value(
          *multi_column_stats_batch_owner_->batches[index],
          multi_column_stats_hash_ids_[index],
          multi_column_stats_hash_collisions_[index], field_.data(),
          field_.size());
    }
  }

  void finish_multi_column_stats_row() {
    if (multi_column_stats_batch_owner_ == nullptr) {
      return;
    }

    for (size_t index = 0;
         index < multi_column_stats_batch_owner_->batches.size(); ++index) {
      auto &batch = *multi_column_stats_batch_owner_->batches[index];
      if (!multi_column_stats_row_seen_[index]) {
        multi_column_stats_row_ids_[index] = intern_column_stats_value(
            batch, multi_column_stats_hash_ids_[index],
            multi_column_stats_hash_collisions_[index], nullptr, 0);
      }
      batch.ids.push_back(multi_column_stats_row_ids_[index]);
      ++batch.counts[multi_column_stats_row_ids_[index]];
    }
  }

  void commit_deferred_batch_row() {
    if (batch_ == nullptr) {
      return;
    }

    if (projection_enabled_) {
      commit_fields(projected_fields_);
    } else {
      commit_fields(row_fields_);
    }
  }

  void commit_fields(const std::vector<std::string> &fields) {
    if (batch_ == nullptr) {
      return;
    }

    for (const auto &field : fields) {
      batch_->data.append(field);
      batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
    }
    finish_batch_row();
  }

  void reset_row_state() {
    current_column_ = 0;
    row_filter_seen_ = false;
    row_filter_matched_ = false;
    dictionary_row_seen_ = false;
    group_by_row_seen_ = false;
    column_stats_row_seen_ = false;
    for (auto &seen : multi_column_stats_row_seen_) {
      seen = false;
    }
    row_fields_.clear();
    for (auto &field : projected_fields_) {
      field.clear();
    }
    deferred_batch_row_ = false;
    direct_projection_row_started_ = false;
    direct_projection_data_start_ = 0;
    direct_projection_field_offsets_start_ = 0;
    direct_projection_carry_count_ = 0;
  }

  void spill_unfinished_direct_projection_row() {
    if (batch_ == nullptr || !saw_row_data_ || !direct_projection_ ||
        !direct_projection_row_started_) {
      return;
    }

    const size_t field_count =
        batch_->field_offsets.size() - direct_projection_field_offsets_start_;
    for (size_t index = direct_projection_carry_count_; index < field_count;
         ++index) {
      const size_t offset_index =
          direct_projection_field_offsets_start_ + index;
      const size_t start = batch_->field_offsets[offset_index - 1];
      const size_t end = batch_->field_offsets[offset_index];
      projected_fields_[index].assign(batch_->data.data() + start, end - start);
    }
    direct_projection_carry_count_ = field_count;
    rollback_direct_projection_row();
  }

  void spill_unfinished_batch_row() {
    if (batch_ == nullptr || !saw_row_data_ || projection_enabled_ ||
        filter_.enabled || fixed_columns_enabled_ || deferred_batch_row_) {
      return;
    }

    const size_t row_start = batch_->row_offsets.back();
    if (row_start >= batch_->field_offsets.size()) {
      return;
    }

    const size_t row_data_start = batch_->field_offsets[row_start];
    const size_t completed_field_count = batch_->field_offsets.size() - 1;
    row_fields_.clear();
    row_fields_.reserve(completed_field_count - row_start);
    for (size_t field_index = row_start; field_index < completed_field_count;
         ++field_index) {
      const size_t start = batch_->field_offsets[field_index];
      const size_t end = batch_->field_offsets[field_index + 1];
      row_fields_.emplace_back(batch_->data.data() + start, end - start);
    }

    if (field_in_arena_) {
      const size_t start = batch_->field_offsets.back();
      const size_t end = batch_->data.size();
      field_.assign(batch_->data.data() + start, end - start);
      field_in_arena_ = false;
    }

    batch_->data.resize(row_data_start);
    batch_->field_offsets.resize(row_start + 1);
    deferred_batch_row_ = true;
  }

  void finish_batch_row() {
    if (batch_ == nullptr) {
      return;
    }

    if (fixed_columns_enabled_) {
      const uint32_t row_start = batch_->row_offsets.back();
      const size_t row_end = batch_->field_offsets.size() - 1;
      const size_t field_count = row_end - row_start;
      if (field_count != fixed_columns_) {
        set_error("fixed row column count mismatch");
        parse_failed_ = true;
        return;
      }
    }

    if (strict_quote_syntax_ && !fixed_columns_enabled_) {
      const uint32_t row_start = batch_->row_offsets.back();
      const size_t row_end = batch_->field_offsets.size() - 1;
      const uint32_t field_count = checked_u32(row_end - row_start);
      if (!strict_expected_columns_seen_) {
        strict_expected_columns_ = field_count;
        strict_expected_columns_seen_ = true;
      } else if (field_count != strict_expected_columns_) {
        set_error("strict CSV row column count mismatch");
        parse_failed_ = true;
        return;
      }
    }

    batch_->row_offsets.push_back(
        checked_u32(batch_->field_offsets.size() - 1));
  }

  void finish_stream() {
    if (pending_quote_) {
      pending_quote_ = false;
      in_quotes_ = false;
    }
    if (in_quotes_) {
      if (strict_quote_syntax_) {
        fail_parse("strict CSV quote syntax error: unterminated quoted field");
        return;
      }
      in_quotes_ = false;
    }
    if (saw_row_data_) {
      finish_row();
    }
  }

  void fail_parse(const char *message) {
    set_error(message);
    parse_failed_ = true;
  }

  static uint32_t checked_u32(size_t value) {
    if (value > std::numeric_limits<uint32_t>::max()) {
      return std::numeric_limits<uint32_t>::max();
    }
    return static_cast<uint32_t>(value);
  }

  static uint32_t intern_dictionary_value(
      csv_dictionary_batch &dictionary,
      std::unordered_map<uint64_t, uint32_t> &hash_ids,
      std::unordered_map<uint64_t, std::vector<uint32_t>> &hash_collisions,
      const char *value, size_t value_len) {
    const char *actual = value == nullptr ? "" : value;
    const uint64_t hash = hash_bytes(actual, value_len);
    const auto found = hash_ids.find(hash);
    if (found != hash_ids.end()) {
      if (dictionary_value_equals(dictionary, found->second, actual,
                                  value_len)) {
        return found->second;
      }

      const auto collisions = hash_collisions.find(hash);
      if (collisions != hash_collisions.end()) {
        for (const uint32_t id : collisions->second) {
          if (dictionary_value_equals(dictionary, id, actual, value_len)) {
            return id;
          }
        }
      }

      const uint32_t id =
          append_dictionary_value(dictionary, actual, value_len);
      hash_collisions[hash].push_back(id);
      return id;
    }

    const uint32_t id = append_dictionary_value(dictionary, actual, value_len);
    hash_ids.emplace(hash, id);
    return id;
  }

  static uint32_t append_dictionary_value(csv_dictionary_batch &dictionary,
                                          const char *value, size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    return id;
  }

  static bool dictionary_value_equals(const csv_dictionary_batch &dictionary,
                                      uint32_t id, const char *value,
                                      size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return bytes_equal(dictionary.dict_data.data() + start, end - start, value,
                       value_len);
  }

  static uint32_t intern_group_by_count_value(
      csv_group_by_count_batch &dictionary,
      std::unordered_map<uint64_t, uint32_t> &hash_ids,
      std::unordered_map<uint64_t, std::vector<uint32_t>> &hash_collisions,
      const char *value, size_t value_len) {
    const char *actual = value == nullptr ? "" : value;
    const uint64_t hash = hash_bytes(actual, value_len);
    const auto found = hash_ids.find(hash);
    if (found != hash_ids.end()) {
      if (group_by_count_value_equals(dictionary, found->second, actual,
                                      value_len)) {
        return found->second;
      }

      const auto collisions = hash_collisions.find(hash);
      if (collisions != hash_collisions.end()) {
        for (const uint32_t id : collisions->second) {
          if (group_by_count_value_equals(dictionary, id, actual, value_len)) {
            return id;
          }
        }
      }

      const uint32_t id =
          append_group_by_count_value(dictionary, actual, value_len);
      hash_collisions[hash].push_back(id);
      return id;
    }

    const uint32_t id =
        append_group_by_count_value(dictionary, actual, value_len);
    hash_ids.emplace(hash, id);
    return id;
  }

  static uint32_t
  append_group_by_count_value(csv_group_by_count_batch &dictionary,
                              const char *value, size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    dictionary.counts.push_back(0);
    return id;
  }

  static bool
  group_by_count_value_equals(const csv_group_by_count_batch &dictionary,
                              uint32_t id, const char *value,
                              size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return bytes_equal(dictionary.dict_data.data() + start, end - start, value,
                       value_len);
  }

  static uint32_t intern_column_stats_value(
      csv_column_stats_batch &dictionary,
      std::unordered_map<uint64_t, uint32_t> &hash_ids,
      std::unordered_map<uint64_t, std::vector<uint32_t>> &hash_collisions,
      const char *value, size_t value_len) {
    const char *actual = value == nullptr ? "" : value;
    const uint64_t hash = hash_bytes(actual, value_len);
    const auto found = hash_ids.find(hash);
    if (found != hash_ids.end()) {
      if (column_stats_value_equals(dictionary, found->second, actual,
                                    value_len)) {
        return found->second;
      }

      const auto collisions = hash_collisions.find(hash);
      if (collisions != hash_collisions.end()) {
        for (const uint32_t id : collisions->second) {
          if (column_stats_value_equals(dictionary, id, actual, value_len)) {
            return id;
          }
        }
      }

      const uint32_t id =
          append_column_stats_value(dictionary, actual, value_len);
      hash_collisions[hash].push_back(id);
      return id;
    }

    const uint32_t id =
        append_column_stats_value(dictionary, actual, value_len);
    hash_ids.emplace(hash, id);
    return id;
  }

  static uint32_t append_column_stats_value(csv_column_stats_batch &dictionary,
                                            const char *value,
                                            size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    dictionary.counts.push_back(0);
    return id;
  }

  static bool
  column_stats_value_equals(const csv_column_stats_batch &dictionary,
                            uint32_t id, const char *value, size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return bytes_equal(dictionary.dict_data.data() + start, end - start, value,
                       value_len);
  }

  static uint64_t hash_bytes(const char *data, size_t len) {
    uint64_t hash = 1469598103934665603ull;
    for (size_t index = 0; index < len; ++index) {
      hash ^= static_cast<uint8_t>(data[index]);
      hash *= 1099511628211ull;
    }
    return hash;
  }

  static bool bytes_equal(const char *left, size_t left_len, const char *right,
                          size_t right_len) {
    return left_len == right_len &&
           (left_len == 0 || std::memcmp(left, right, left_len) == 0);
  }

  csv_encoding encoding_;
  uint8_t delimiter_;
  output_mode mode_ = output_mode::batch;
  csv_batch *batch_ = nullptr;
  csv_dictionary_batch *dictionary_batch_ = nullptr;
  csv_group_by_count_batch *group_by_count_batch_ = nullptr;
  std::unique_ptr<csv_group_by_count_batch> group_by_count_batch_owner_;
  csv_column_stats_batch *column_stats_batch_ = nullptr;
  std::unique_ptr<csv_column_stats_batch> column_stats_batch_owner_;
  std::unique_ptr<csv_multi_column_stats_batch> multi_column_stats_batch_owner_;
  const uint32_t *selected_columns_ = nullptr;
  size_t selected_columns_len_ = 0;
  std::vector<uint8_t> selected_column_counts_;
  std::vector<std::vector<uint32_t>> selected_column_outputs_;
  bool projection_enabled_ = false;
  bool direct_projection_ = false;
  bool fixed_columns_enabled_ = false;
  bool strict_quote_syntax_ = false;
  uint32_t fixed_columns_ = 0;
  uint32_t strict_expected_columns_ = 0;
  bool strict_expected_columns_seen_ = false;
  bool parse_failed_ = false;
  bool direct_projection_row_started_ = false;
  size_t direct_projection_data_start_ = 0;
  size_t direct_projection_field_offsets_start_ = 0;
  size_t direct_projection_carry_count_ = 0;
  row_filter filter_;
  std::string field_;
  std::string trusted_row_buffer_;
  std::vector<std::string> row_fields_;
  std::vector<std::string> projected_fields_;
  std::unordered_map<uint64_t, uint32_t> dictionary_hash_ids_;
  std::unordered_map<uint64_t, std::vector<uint32_t>>
      dictionary_hash_collisions_;
  std::unordered_map<uint64_t, uint32_t> group_by_hash_ids_;
  std::unordered_map<uint64_t, std::vector<uint32_t>> group_by_hash_collisions_;
  std::unordered_map<uint64_t, uint32_t> column_stats_hash_ids_;
  std::unordered_map<uint64_t, std::vector<uint32_t>>
      column_stats_hash_collisions_;
  std::unordered_map<uint32_t, std::vector<size_t>> multi_column_stats_indexes_;
  std::vector<std::unordered_map<uint64_t, uint32_t>>
      multi_column_stats_hash_ids_;
  std::vector<std::unordered_map<uint64_t, std::vector<uint32_t>>>
      multi_column_stats_hash_collisions_;
  std::vector<uint32_t> multi_column_stats_row_ids_;
  std::vector<uint8_t> multi_column_stats_row_seen_;
  std::string error_;
  bool in_quotes_ = false;
  bool pending_quote_ = false;
  bool at_field_start_ = true;
  bool saw_row_data_ = false;
  bool previous_was_cr_ = false;
  uint32_t current_column_ = 0;
  bool row_filter_seen_ = false;
  bool row_filter_matched_ = false;
  uint32_t dictionary_column_ = 0;
  uint32_t dictionary_row_id_ = 0;
  bool dictionary_row_seen_ = false;
  uint32_t group_by_column_ = 0;
  uint32_t group_by_row_id_ = 0;
  bool group_by_row_seen_ = false;
  uint32_t column_stats_column_ = 0;
  uint32_t column_stats_row_id_ = 0;
  bool column_stats_row_seen_ = false;
  bool field_in_arena_ = false;
  mutable bool complete_quoted_field_has_escape_ = false;
  bool allow_direct_projection_ = false;
  bool deferred_batch_row_ = false;
  uint64_t emitted_rows_ = 0;
};

csv_parser *checked_parser(void *parser) {
  return static_cast<csv_parser *>(parser);
}

csv_batch *checked_batch(void *batch) {
  return static_cast<csv_batch *>(batch);
}

csv_dictionary_batch *checked_dictionary_batch(void *batch) {
  return static_cast<csv_dictionary_batch *>(batch);
}

csv_group_by_count_batch *checked_group_by_count_batch(void *batch) {
  return static_cast<csv_group_by_count_batch *>(batch);
}

csv_column_stats_batch *checked_column_stats_batch(void *batch) {
  return static_cast<csv_column_stats_batch *>(batch);
}

csv_split_offsets_batch *checked_split_offsets_batch(void *batch) {
  return static_cast<csv_split_offsets_batch *>(batch);
}

bool valid_value_offsets(const uint32_t *offsets, size_t value_count,
                         uint64_t values_data_len) {
  if (value_count == 0 || offsets == nullptr) {
    return false;
  }
  uint32_t previous = offsets[0];
  if (previous != 0 || previous > values_data_len) {
    return false;
  }
  for (size_t index = 0; index < value_count; ++index) {
    const uint32_t next = offsets[index + 1];
    if (next < previous || next > values_data_len) {
      return false;
    }
    previous = next;
  }
  return true;
}

csv_multi_column_stats_batch *checked_multi_column_stats_batch(void *batch) {
  return static_cast<csv_multi_column_stats_batch *>(batch);
}

} // namespace csv_native

CSV_EXPORT void *csv_parser_create(int encoding, uint8_t delimiter) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' ||
      delimiter == '"') {
    return nullptr;
  }
  const auto selected = encoding == 1 ? csv_native::csv_encoding::latin1
                                      : csv_native::csv_encoding::utf8;
  return new csv_native::csv_parser(selected, delimiter);
}

CSV_EXPORT void csv_parser_destroy(void *parser) {
  delete csv_native::checked_parser(parser);
}

CSV_EXPORT void csv_parser_reset(void *parser) {
  if (parser == nullptr) {
    return;
  }
  csv_native::checked_parser(parser)->reset();
}

CSV_EXPORT void *csv_parser_write_batch(void *parser, const uint8_t *data,
                                        uint64_t len, bool final) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_batch(
      data, static_cast<size_t>(len), final);
}

CSV_EXPORT void *csv_parser_write_strict_batch(void *parser,
                                               const uint8_t *data,
                                               uint64_t len, bool final) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_strict_batch(
      data, static_cast<size_t>(len), final);
}

CSV_EXPORT void *csv_parser_finish_batch(void *parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_batch();
}

CSV_EXPORT void *csv_parser_finish_strict_batch(void *parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_strict_batch();
}

CSV_EXPORT void *csv_parser_write_fixed_batch(void *parser, const uint8_t *data,
                                              uint64_t len, bool final,
                                              uint32_t fixed_columns) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_fixed_batch(
      data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void *csv_parser_write_strict_fixed_batch(void *parser,
                                                     const uint8_t *data,
                                                     uint64_t len, bool final,
                                                     uint32_t fixed_columns) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_strict_fixed_batch(
      data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void *csv_parser_finish_fixed_batch(void *parser,
                                               uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_fixed_batch(fixed_columns);
}

CSV_EXPORT void *csv_parser_finish_strict_fixed_batch(void *parser,
                                                      uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_strict_fixed_batch(
      fixed_columns);
}

CSV_EXPORT void *csv_parser_write_trusted_fixed_batch(void *parser,
                                                      const uint8_t *data,
                                                      uint64_t len, bool final,
                                                      uint32_t fixed_columns) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_trusted_fixed_batch(
      data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void *
csv_parser_write_strict_trusted_fixed_batch(void *parser, const uint8_t *data,
                                            uint64_t len, bool final,
                                            uint32_t fixed_columns) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_strict_trusted_fixed_batch(
      data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void *csv_parser_finish_trusted_fixed_batch(void *parser,
                                                       uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_trusted_fixed_batch(
      fixed_columns);
}

CSV_EXPORT void *
csv_parser_finish_strict_trusted_fixed_batch(void *parser,
                                             uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_strict_trusted_fixed_batch(
      fixed_columns);
}

CSV_EXPORT void *csv_parser_write_projected_batch(
    void *parser, const uint8_t *data, uint64_t len, bool final,
    bool has_projection, const uint32_t *selected_columns,
    uint64_t selected_columns_len, bool has_filter, uint32_t filter_column,
    const uint8_t *filter_value, uint64_t filter_value_len) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      selected_columns_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (has_projection && selected_columns == nullptr) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_projected_batch(
      data, static_cast<size_t>(len), final,
      has_projection ? selected_columns : nullptr,
      has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::row_filter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::row_filter_kind::equals
                             : csv_native::row_filter_kind::none,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT void *csv_parser_finish_projected_batch(
    void *parser, bool has_projection, const uint32_t *selected_columns,
    uint64_t selected_columns_len, bool has_filter, uint32_t filter_column,
    const uint8_t *filter_value, uint64_t filter_value_len) {
  if (parser == nullptr ||
      selected_columns_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (has_projection && selected_columns == nullptr) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_projected_batch(
      has_projection ? selected_columns : nullptr,
      has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::row_filter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::row_filter_kind::equals
                             : csv_native::row_filter_kind::none,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT void *csv_parser_write_dictionary_batch(void *parser,
                                                   const uint8_t *data,
                                                   uint64_t len, bool final,
                                                   uint32_t column) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_dictionary_batch(
      data, static_cast<size_t>(len), final, column);
}

CSV_EXPORT void *csv_parser_finish_dictionary_batch(void *parser,
                                                    uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_dictionary_batch(column);
}

CSV_EXPORT uint64_t csv_parser_write_group_by_count(void *parser,
                                                    const uint8_t *data,
                                                    uint64_t len,
                                                    uint32_t column) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_group_by_count(
      data, static_cast<size_t>(len), column);
}

CSV_EXPORT void *csv_parser_finish_group_by_count(void *parser,
                                                  uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_group_by_count(column);
}

CSV_EXPORT uint64_t csv_parser_write_column_stats(void *parser,
                                                  const uint8_t *data,
                                                  uint64_t len,
                                                  uint32_t column) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_column_stats(
      data, static_cast<size_t>(len), column);
}

CSV_EXPORT void *csv_parser_finish_column_stats(void *parser, uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_column_stats(column);
}

CSV_EXPORT uint64_t csv_parser_write_multi_column_stats(void *parser,
                                                        const uint8_t *data,
                                                        uint64_t len,
                                                        const uint32_t *columns,
                                                        uint64_t columns_len) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      columns_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (columns == nullptr && columns_len != 0)) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_multi_column_stats(
      data, static_cast<size_t>(len), columns,
      static_cast<size_t>(columns_len));
}

CSV_EXPORT void *csv_parser_finish_multi_column_stats(void *parser,
                                                      const uint32_t *columns,
                                                      uint64_t columns_len) {
  if (parser == nullptr ||
      columns_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (columns == nullptr && columns_len != 0)) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_multi_column_stats(
      columns, static_cast<size_t>(columns_len));
}

CSV_EXPORT void csv_batch_destroy(void *batch) {
  delete static_cast<csv_native::csv_batch *>(batch);
}

CSV_EXPORT void csv_dictionary_batch_destroy(void *batch) {
  delete static_cast<csv_native::csv_dictionary_batch *>(batch);
}

CSV_EXPORT void csv_group_by_count_batch_destroy(void *batch) {
  delete static_cast<csv_native::csv_group_by_count_batch *>(batch);
}

CSV_EXPORT void csv_column_stats_batch_destroy(void *batch) {
  delete static_cast<csv_native::csv_column_stats_batch *>(batch);
}

CSV_EXPORT void *csv_group_by_count_batch_create(
    const uint8_t *dict_data, uint64_t dict_data_len,
    const uint32_t *dict_offsets, uint64_t dict_offsets_len,
    const uint64_t *counts, uint64_t counts_len, uint64_t row_count) {
  if (dict_data_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      dict_offsets_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      counts_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      row_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (dict_data == nullptr && dict_data_len != 0) ||
      (dict_offsets == nullptr && dict_offsets_len != 0) ||
      (counts == nullptr && counts_len != 0) || dict_offsets_len == 0 ||
      dict_offsets_len != counts_len + 1) {
    return nullptr;
  }

  const size_t data_len = static_cast<size_t>(dict_data_len);
  const size_t offsets_len = static_cast<size_t>(dict_offsets_len);
  const size_t counts_size = static_cast<size_t>(counts_len);
  if (dict_offsets[0] != 0 ||
      dict_offsets[offsets_len - 1] != static_cast<uint32_t>(data_len)) {
    return nullptr;
  }
  for (size_t index = 1; index < offsets_len; ++index) {
    if (dict_offsets[index] < dict_offsets[index - 1]) {
      return nullptr;
    }
  }

  auto *batch = new csv_native::csv_group_by_count_batch();
  batch->row_count = row_count;
  batch->counts.assign(counts, counts + counts_size);
  batch->dict_offsets.assign(dict_offsets, dict_offsets + offsets_len);
  batch->dict_data.assign(reinterpret_cast<const char *>(dict_data), data_len);
  return batch;
}

CSV_EXPORT void *csv_column_stats_batch_create(
    const uint32_t *ids, uint64_t ids_len, const uint64_t *counts,
    uint64_t counts_len, const uint32_t *dict_offsets,
    uint64_t dict_offsets_len, const uint8_t *dict_data,
    uint64_t dict_data_len) {
  if (ids_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      counts_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      dict_offsets_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      dict_data_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (ids == nullptr && ids_len != 0) ||
      (counts == nullptr && counts_len != 0) ||
      (dict_offsets == nullptr && dict_offsets_len != 0) ||
      (dict_data == nullptr && dict_data_len != 0) || dict_offsets_len == 0 ||
      dict_offsets_len != counts_len + 1) {
    return nullptr;
  }

  const size_t row_count = static_cast<size_t>(ids_len);
  const size_t dict_count = static_cast<size_t>(counts_len);
  const size_t offsets_len = static_cast<size_t>(dict_offsets_len);
  const size_t data_len = static_cast<size_t>(dict_data_len);
  if (dict_offsets[0] != 0 ||
      dict_offsets[offsets_len - 1] != static_cast<uint32_t>(data_len)) {
    return nullptr;
  }
  for (size_t index = 1; index < offsets_len; ++index) {
    if (dict_offsets[index] < dict_offsets[index - 1]) {
      return nullptr;
    }
  }
  for (size_t index = 0; index < row_count; ++index) {
    if (ids[index] >= dict_count && dict_count != 0) {
      return nullptr;
    }
  }

  auto *batch = new csv_native::csv_column_stats_batch();
  batch->ids.assign(ids, ids + row_count);
  batch->counts.assign(counts, counts + dict_count);
  batch->dict_offsets.assign(dict_offsets, dict_offsets + offsets_len);
  batch->dict_data.assign(reinterpret_cast<const char *>(dict_data), data_len);
  return batch;
}

CSV_EXPORT void csv_multi_column_stats_batch_destroy(void *batch) {
  delete static_cast<csv_native::csv_multi_column_stats_batch *>(batch);
}

CSV_EXPORT uint64_t csv_dictionary_batch_row_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_dictionary_batch(batch)->row_count();
}

CSV_EXPORT uint64_t csv_dictionary_batch_dict_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_dictionary_batch(batch)->dict_count();
}

CSV_EXPORT const uint32_t *csv_dictionary_batch_ids_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_dictionary_batch(batch)->ids.data();
}

CSV_EXPORT const uint32_t *csv_dictionary_batch_offsets_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_dictionary_batch(batch)->dict_offsets.data();
}

CSV_EXPORT uint64_t csv_dictionary_batch_data_len(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_dictionary_batch(batch)->dict_data.size();
}

CSV_EXPORT const uint8_t *csv_dictionary_batch_data_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto *typed = csv_native::checked_dictionary_batch(batch);
  return reinterpret_cast<const uint8_t *>(typed->dict_data.data());
}

CSV_EXPORT uint64_t csv_group_by_count_batch_row_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_group_by_count_batch(batch)->row_count;
}

CSV_EXPORT uint64_t csv_group_by_count_batch_dict_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_group_by_count_batch(batch)->dict_count();
}

CSV_EXPORT const uint64_t *csv_group_by_count_batch_counts_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_group_by_count_batch(batch)->counts.data();
}

CSV_EXPORT const uint32_t *csv_group_by_count_batch_offsets_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_group_by_count_batch(batch)->dict_offsets.data();
}

CSV_EXPORT uint64_t csv_group_by_count_batch_data_len(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_group_by_count_batch(batch)->dict_data.size();
}

CSV_EXPORT const uint8_t *csv_group_by_count_batch_data_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto *typed = csv_native::checked_group_by_count_batch(batch);
  return reinterpret_cast<const uint8_t *>(typed->dict_data.data());
}

CSV_EXPORT uint64_t csv_column_stats_batch_row_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_column_stats_batch(batch)->row_count();
}

CSV_EXPORT uint64_t csv_column_stats_batch_dict_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_column_stats_batch(batch)->dict_count();
}

CSV_EXPORT const uint32_t *csv_column_stats_batch_ids_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_column_stats_batch(batch)->ids.data();
}

CSV_EXPORT const uint64_t *csv_column_stats_batch_counts_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_column_stats_batch(batch)->counts.data();
}

CSV_EXPORT const uint32_t *csv_column_stats_batch_offsets_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_column_stats_batch(batch)->dict_offsets.data();
}

CSV_EXPORT uint64_t csv_column_stats_batch_data_len(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_column_stats_batch(batch)->dict_data.size();
}

CSV_EXPORT const uint8_t *csv_column_stats_batch_data_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto *typed = csv_native::checked_column_stats_batch(batch);
  return reinterpret_cast<const uint8_t *>(typed->dict_data.data());
}

CSV_EXPORT uint64_t csv_multi_column_stats_batch_column_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_multi_column_stats_batch(batch)->column_count();
}

CSV_EXPORT uint32_t csv_multi_column_stats_batch_column_at(void *batch,
                                                           uint64_t index) {
  if (batch == nullptr) {
    return 0;
  }
  const auto *typed = csv_native::checked_multi_column_stats_batch(batch);
  if (index >= typed->columns.size()) {
    return 0;
  }
  return typed->columns[static_cast<size_t>(index)];
}

CSV_EXPORT void *
csv_multi_column_stats_batch_take_column_batch(void *batch, uint64_t index) {
  if (batch == nullptr) {
    return nullptr;
  }
  auto *typed = csv_native::checked_multi_column_stats_batch(batch);
  if (index >= typed->batches.size()) {
    return nullptr;
  }
  return typed->batches[static_cast<size_t>(index)].release();
}

CSV_EXPORT uint64_t csv_batch_row_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto *typed = static_cast<const csv_native::csv_batch *>(batch);
  return typed->row_offsets.empty() ? 0 : typed->row_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_total_fields(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto *typed = static_cast<const csv_native::csv_batch *>(batch);
  return typed->field_offsets.empty() ? 0 : typed->field_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_data_len(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return static_cast<const csv_native::csv_batch *>(batch)->data.size();
}

CSV_EXPORT const uint8_t *csv_batch_data_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto *typed = static_cast<const csv_native::csv_batch *>(batch);
  return reinterpret_cast<const uint8_t *>(typed->data.data());
}

CSV_EXPORT const uint32_t *csv_batch_row_offsets_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::csv_batch *>(batch)->row_offsets.data();
}

CSV_EXPORT const uint32_t *csv_batch_field_offsets_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::csv_batch *>(batch)
      ->field_offsets.data();
}

CSV_EXPORT uint64_t csv_batch_count_where_equals(void *batch, uint32_t column,
                                                 const uint8_t *value,
                                                 uint64_t value_len) {
  if (batch == nullptr || (value == nullptr && value_len != 0) ||
      value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  const auto *typed = csv_native::checked_batch(batch);
  const auto needle_len = static_cast<size_t>(value_len);
  uint64_t count = 0;

  for (size_t row = 0; row + 1 < typed->row_offsets.size(); ++row) {
    const size_t row_begin = typed->row_offsets[row];
    const size_t row_end = typed->row_offsets[row + 1];
    const size_t field_index = row_begin + column;
    if (field_index >= row_end) {
      continue;
    }

    const size_t start = typed->field_offsets[field_index];
    const size_t end = typed->field_offsets[field_index + 1];
    const size_t len = end - start;
    if (len == needle_len &&
        std::memcmp(typed->data.data() + start, value, len) == 0) {
      ++count;
    }
  }

  return count;
}

CSV_EXPORT uint64_t csv_parser_write_count(void *parser, const uint8_t *data,
                                           uint64_t len, bool final) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_count(
      data, static_cast<size_t>(len), final);
}

CSV_EXPORT uint64_t csv_parser_count_trusted_newlines(const uint8_t *data,
                                                      uint64_t len) {
  if (len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::count_trusted_newlines(data, static_cast<size_t>(len));
}

CSV_EXPORT void *csv_parser_find_split_offsets(const char *path,
                                               uint64_t shard_count,
                                               uint8_t delimiter) {
  if (shard_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }
  auto batch = csv_native::find_csv_safe_split_offsets(
      path, static_cast<size_t>(shard_count), delimiter);
  return batch.release();
}

CSV_EXPORT void csv_split_offsets_batch_destroy(void *batch) {
  delete csv_native::checked_split_offsets_batch(batch);
}

CSV_EXPORT uint64_t csv_split_offsets_batch_count(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_split_offsets_batch(batch)->offsets.size();
}

CSV_EXPORT const uint64_t *csv_split_offsets_batch_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_split_offsets_batch(batch)->offsets.data();
}

CSV_EXPORT uint64_t csv_parser_finish_count(void *parser) {
  if (parser == nullptr) {
    return 0;
  }

  return csv_native::checked_parser(parser)->finish_count();
}

CSV_EXPORT uint64_t csv_parser_write_count_where_equals(
    void *parser, const uint8_t *data, uint64_t len, bool final,
    uint32_t filter_column, const uint8_t *filter_value,
    uint64_t filter_value_len) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_count_where_equals(
      data, static_cast<size_t>(len), final,
      csv_native::row_filter{
          .enabled = true,
          .kind = csv_native::row_filter_kind::equals,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT uint64_t csv_parser_write_count_where_in(
    void *parser, const uint8_t *data, uint64_t len, bool final,
    uint32_t filter_column, const uint8_t *values_data,
    uint64_t values_data_len, const uint32_t *value_offsets,
    uint64_t value_count) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      values_data_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      value_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (values_data == nullptr && values_data_len != 0) ||
      !csv_native::valid_value_offsets(
          value_offsets, static_cast<size_t>(value_count), values_data_len)) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_count_where_in(
      data, static_cast<size_t>(len), final,
      csv_native::row_filter{
          .enabled = true,
          .kind = csv_native::row_filter_kind::in,
          .column = filter_column,
          .values_data = values_data,
          .value_offsets = value_offsets,
          .value_count = static_cast<size_t>(value_count),
      });
}

CSV_EXPORT uint64_t csv_parser_write_count_where_starts_with(
    void *parser, const uint8_t *data, uint64_t len, bool final,
    uint32_t filter_column, const uint8_t *filter_value,
    uint64_t filter_value_len) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_count_where_starts_with(
      data, static_cast<size_t>(len), final,
      csv_native::row_filter{
          .enabled = true,
          .kind = csv_native::row_filter_kind::starts_with,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_equals(
    void *parser, uint32_t filter_column, const uint8_t *filter_value,
    uint64_t filter_value_len) {
  if (parser == nullptr ||
      filter_value_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  return csv_native::checked_parser(parser)->finish_count_where_equals(
      csv_native::row_filter{
          .enabled = true,
          .kind = csv_native::row_filter_kind::equals,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_in(
    void *parser, uint32_t filter_column, const uint8_t *values_data,
    uint64_t values_data_len, const uint32_t *value_offsets,
    uint64_t value_count) {
  if (parser == nullptr ||
      values_data_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      value_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (values_data == nullptr && values_data_len != 0) ||
      !csv_native::valid_value_offsets(
          value_offsets, static_cast<size_t>(value_count), values_data_len)) {
    return 0;
  }

  return csv_native::checked_parser(parser)->finish_count_where_in(
      csv_native::row_filter{
          .enabled = true,
          .kind = csv_native::row_filter_kind::in,
          .column = filter_column,
          .values_data = values_data,
          .value_offsets = value_offsets,
          .value_count = static_cast<size_t>(value_count),
      });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_starts_with(
    void *parser, uint32_t filter_column, const uint8_t *filter_value,
    uint64_t filter_value_len) {
  if (parser == nullptr ||
      filter_value_len >
          static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  return csv_native::checked_parser(parser)->finish_count_where_starts_with(
      csv_native::row_filter{
          .enabled = true,
          .kind = csv_native::row_filter_kind::starts_with,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT const char *csv_parser_last_error(void *parser) {
  if (parser == nullptr) {
    return "parser is null";
  }
  return csv_native::checked_parser(parser)->last_error();
}
