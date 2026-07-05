#include <hwy/highway.h>

#include <cstdint>
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

enum class Encoding : int {
  kUtf8 = 0,
  kLatin1 = 1,
};

enum class OutputMode {
  kBatch,
  kCount,
  kDictionary,
  kGroupByCount,
  kColumnStats,
  kMultiColumnStats,
};

enum class RowFilterKind : uint8_t {
  kNone = 0,
  kEquals = 1,
  kIn = 2,
  kStartsWith = 3,
};

struct RowFilter {
  bool enabled = false;
  RowFilterKind kind = RowFilterKind::kNone;
  uint32_t column = 0;
  const uint8_t *value = nullptr;
  size_t value_len = 0;
  const uint8_t *values_data = nullptr;
  const uint32_t *value_offsets = nullptr;
  size_t value_count = 0;
};

struct CsvBatch {
  std::vector<uint32_t> row_offsets{0};
  std::vector<uint32_t> field_offsets{0};
  std::string data;

  void Reserve(size_t input_len, Encoding encoding) {
    const size_t data_capacity =
        encoding == Encoding::kLatin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    field_offsets.reserve((input_len / 6) + 32);
    row_offsets.reserve((input_len / 160) + 32);
  }

  void ReserveTrusted(size_t input_len, Encoding encoding,
                      uint32_t fixed_columns, size_t rows_hint) {
    const size_t data_capacity =
        encoding == Encoding::kLatin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    const size_t fields_hint =
        rows_hint * static_cast<size_t>(fixed_columns) + 1;
    field_offsets.reserve(fields_hint);
    row_offsets.reserve(rows_hint + 1);
  }

  void ReserveFixed(size_t input_len, Encoding encoding,
                    uint32_t fixed_columns) {
    const size_t data_capacity =
        encoding == Encoding::kLatin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    const size_t rows_hint = (input_len / 160) + 32;
    field_offsets.reserve(rows_hint * static_cast<size_t>(fixed_columns) + 1);
    row_offsets.reserve(rows_hint + 1);
  }
};

struct CsvDictionaryBatch {
  std::vector<uint32_t> ids;
  std::vector<uint32_t> dict_offsets{0};
  std::string dict_data;

  uint64_t row_count() const { return ids.size(); }

  uint64_t dict_count() const {
    return dict_offsets.empty() ? 0 : dict_offsets.size() - 1;
  }
};

struct CsvGroupByCountBatch {
  std::vector<uint64_t> counts;
  std::vector<uint32_t> dict_offsets{0};
  std::string dict_data;
  uint64_t row_count = 0;

  uint64_t dict_count() const {
    return dict_offsets.empty() ? 0 : dict_offsets.size() - 1;
  }
};

struct CsvColumnStatsBatch {
  std::vector<uint32_t> ids;
  std::vector<uint64_t> counts;
  std::vector<uint32_t> dict_offsets{0};
  std::string dict_data;

  uint64_t row_count() const { return ids.size(); }

  uint64_t dict_count() const {
    return dict_offsets.empty() ? 0 : dict_offsets.size() - 1;
  }
};

struct CsvMultiColumnStatsBatch {
  std::vector<uint32_t> columns;
  std::vector<std::unique_ptr<CsvColumnStatsBatch>> batches;

  uint64_t column_count() const { return batches.size(); }
};

constexpr size_t kNpos = std::numeric_limits<size_t>::max();

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
constexpr size_t kLatin1SimdBlock = 16;

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
  out.resize(offset + kLatin1SimdBlock * 2);
  _mm256_storeu_si256(reinterpret_cast<__m256i *>(out.data() + offset), packed);
}
#define CSV_NATIVE_LATIN1_SIMD_BLOCK 1
#elif defined(__ARM_NEON) && defined(__aarch64__)
constexpr size_t kLatin1SimdBlock = 16;

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
  out.resize(offset + kLatin1SimdBlock * 2);
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
    if (i + kLatin1SimdBlock <= len &&
        latin1_simd_block_all_non_ascii(data + i)) {
      append_latin1_simd_non_ascii_block(out, data + i);
      i += kLatin1SimdBlock;
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
  return kNpos;
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
  return kNpos;
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

class CsvParser {
public:
  CsvParser(Encoding encoding, uint8_t delimiter)
      : encoding_(encoding), delimiter_(delimiter) {}

  CsvBatch *WriteBatch(const uint8_t *data, size_t len, bool final) {
    return WriteProjectedBatch(data, len, final, nullptr, 0, RowFilter{});
  }

  CsvBatch *WriteFixedBatch(const uint8_t *data, size_t len, bool final,
                            uint32_t fixed_columns) {
    if (fixed_columns == 0) {
      SetError("fixed columns must be greater than zero");
      return nullptr;
    }

    auto batch = std::make_unique<CsvBatch>();
    batch->ReserveFixed(len, encoding_, fixed_columns);
    mode_ = OutputMode::kBatch;
    batch_ = batch.get();
    Configure(nullptr, 0, RowFilter{});
    fixed_columns_enabled_ = true;
    fixed_columns_ = fixed_columns;
    parse_failed_ = false;
    emitted_rows_ = 0;
    Parse(data, len);
    if (final) {
      FinishStream();
    }
    fixed_columns_enabled_ = false;
    fixed_columns_ = 0;
    batch_ = nullptr;
    if (parse_failed_) {
      return nullptr;
    }
    return batch.release();
  }

  CsvBatch *WriteTrustedFixedBatch(const uint8_t *data, size_t len, bool final,
                                   uint32_t fixed_columns) {
    if (fixed_columns == 0) {
      SetError("trusted fixed columns must be greater than zero");
      return nullptr;
    }

    auto batch = std::make_unique<CsvBatch>();
    batch->ReserveTrusted(
        len, encoding_, fixed_columns,
        static_cast<size_t>(count_trusted_newlines(data, len)));
    mode_ = OutputMode::kBatch;
    batch_ = batch.get();
    Configure(nullptr, 0, RowFilter{});
    emitted_rows_ = 0;
    if (!ParseTrustedFixedRows(data, len, final, fixed_columns)) {
      batch_ = nullptr;
      return nullptr;
    }
    batch_ = nullptr;
    return batch.release();
  }

  CsvBatch *WriteProjectedBatch(const uint8_t *data, size_t len, bool final,
                                const uint32_t *selected_columns,
                                size_t selected_columns_len, RowFilter filter) {
    auto batch = std::make_unique<CsvBatch>();
    batch->Reserve(len, encoding_);
    mode_ = OutputMode::kBatch;
    batch_ = batch.get();
    Configure(selected_columns, selected_columns_len, filter);
    emitted_rows_ = 0;
    Parse(data, len);
    if (final) {
      FinishStream();
    }
    batch_ = nullptr;
    return batch.release();
  }

  CsvBatch *FinishBatch() { return WriteBatch(nullptr, 0, true); }

  CsvBatch *FinishFixedBatch(uint32_t fixed_columns) {
    return WriteFixedBatch(nullptr, 0, true, fixed_columns);
  }

  CsvBatch *FinishTrustedFixedBatch(uint32_t fixed_columns) {
    return WriteTrustedFixedBatch(nullptr, 0, true, fixed_columns);
  }

  CsvBatch *FinishProjectedBatch(const uint32_t *selected_columns,
                                 size_t selected_columns_len,
                                 RowFilter filter) {
    return WriteProjectedBatch(nullptr, 0, true, selected_columns,
                               selected_columns_len, filter);
  }

  CsvDictionaryBatch *WriteDictionaryBatch(const uint8_t *data, size_t len,
                                           bool final, uint32_t column) {
    auto dictionary = std::make_unique<CsvDictionaryBatch>();
    dictionary->ids.reserve((len / 160) + 32);
    mode_ = OutputMode::kDictionary;
    dictionary_batch_ = dictionary.get();
    dictionary_column_ = column;
    dictionary_hash_ids_.clear();
    dictionary_hash_ids_.reserve(128);
    dictionary_hash_collisions_.clear();
    emitted_rows_ = 0;
    Parse(data, len);
    if (final) {
      FinishStream();
    }
    dictionary_batch_ = nullptr;

    return dictionary.release();
  }

  CsvDictionaryBatch *FinishDictionaryBatch(uint32_t column) {
    return WriteDictionaryBatch(nullptr, 0, true, column);
  }

  uint64_t WriteGroupByCount(const uint8_t *data, size_t len, uint32_t column) {
    if (group_by_count_batch_owner_ == nullptr) {
      group_by_count_batch_owner_ = std::make_unique<CsvGroupByCountBatch>();
      group_by_hash_ids_.clear();
      group_by_hash_ids_.reserve(128);
      group_by_hash_collisions_.clear();
      group_by_column_ = column;
    } else if (group_by_column_ != column) {
      SetError("groupBy count column changed during stream");
      return 0;
    }

    mode_ = OutputMode::kGroupByCount;
    group_by_count_batch_ = group_by_count_batch_owner_.get();
    emitted_rows_ = 0;
    Parse(data, len);
    return emitted_rows_;
  }

  CsvGroupByCountBatch *FinishGroupByCount(uint32_t column) {
    if (group_by_count_batch_owner_ == nullptr) {
      group_by_count_batch_owner_ = std::make_unique<CsvGroupByCountBatch>();
      group_by_hash_ids_.clear();
      group_by_hash_ids_.reserve(128);
      group_by_hash_collisions_.clear();
      group_by_column_ = column;
    } else if (group_by_column_ != column) {
      SetError("groupBy count column changed during stream");
      return nullptr;
    }

    mode_ = OutputMode::kGroupByCount;
    group_by_count_batch_ = group_by_count_batch_owner_.get();
    emitted_rows_ = 0;
    FinishStream();
    group_by_count_batch_ = nullptr;
    group_by_hash_ids_.clear();
    group_by_hash_collisions_.clear();
    return group_by_count_batch_owner_.release();
  }

  uint64_t WriteColumnStats(const uint8_t *data, size_t len, uint32_t column) {
    if (column_stats_batch_owner_ == nullptr) {
      column_stats_batch_owner_ = std::make_unique<CsvColumnStatsBatch>();
      column_stats_hash_ids_.clear();
      column_stats_hash_ids_.reserve(128);
      column_stats_hash_collisions_.clear();
      column_stats_column_ = column;
    } else if (column_stats_column_ != column) {
      SetError("column stats column changed during stream");
      return 0;
    }

    mode_ = OutputMode::kColumnStats;
    column_stats_batch_ = column_stats_batch_owner_.get();
    emitted_rows_ = 0;
    Parse(data, len);
    return emitted_rows_;
  }

  CsvColumnStatsBatch *FinishColumnStats(uint32_t column) {
    if (column_stats_batch_owner_ == nullptr) {
      column_stats_batch_owner_ = std::make_unique<CsvColumnStatsBatch>();
      column_stats_hash_ids_.clear();
      column_stats_hash_ids_.reserve(128);
      column_stats_hash_collisions_.clear();
      column_stats_column_ = column;
    } else if (column_stats_column_ != column) {
      SetError("column stats column changed during stream");
      return nullptr;
    }

    mode_ = OutputMode::kColumnStats;
    column_stats_batch_ = column_stats_batch_owner_.get();
    emitted_rows_ = 0;
    FinishStream();
    column_stats_batch_ = nullptr;
    column_stats_hash_ids_.clear();
    column_stats_hash_collisions_.clear();
    return column_stats_batch_owner_.release();
  }

  uint64_t WriteMultiColumnStats(const uint8_t *data, size_t len,
                                 const uint32_t *columns, size_t columns_len) {
    if (!EnsureMultiColumnStats(columns, columns_len, len)) {
      return 0;
    }

    mode_ = OutputMode::kMultiColumnStats;
    emitted_rows_ = 0;
    Parse(data, len);
    return emitted_rows_;
  }

  CsvMultiColumnStatsBatch *FinishMultiColumnStats(const uint32_t *columns,
                                                   size_t columns_len) {
    if (!EnsureMultiColumnStats(columns, columns_len, 0)) {
      return nullptr;
    }

    mode_ = OutputMode::kMultiColumnStats;
    emitted_rows_ = 0;
    FinishStream();
    multi_column_stats_indexes_.clear();
    multi_column_stats_hash_ids_.clear();
    multi_column_stats_hash_collisions_.clear();
    multi_column_stats_row_ids_.clear();
    multi_column_stats_row_seen_.clear();
    return multi_column_stats_batch_owner_.release();
  }

  uint64_t WriteCount(const uint8_t *data, size_t len, bool final) {
    return WriteCountWhere(data, len, final, RowFilter{});
  }

  uint64_t WriteCountWhereEquals(const uint8_t *data, size_t len, bool final,
                                 RowFilter filter) {
    filter.kind =
        filter.enabled ? RowFilterKind::kEquals : RowFilterKind::kNone;
    return WriteCountWhere(data, len, final, filter);
  }

  uint64_t WriteCountWhereIn(const uint8_t *data, size_t len, bool final,
                             RowFilter filter) {
    filter.kind = filter.enabled ? RowFilterKind::kIn : RowFilterKind::kNone;
    return WriteCountWhere(data, len, final, filter);
  }

  uint64_t WriteCountWhereStartsWith(const uint8_t *data, size_t len,
                                     bool final, RowFilter filter) {
    filter.kind =
        filter.enabled ? RowFilterKind::kStartsWith : RowFilterKind::kNone;
    return WriteCountWhere(data, len, final, filter);
  }

  uint64_t WriteCountWhere(const uint8_t *data, size_t len, bool final,
                           RowFilter filter) {
    mode_ = OutputMode::kCount;
    Configure(nullptr, 0, filter);
    emitted_rows_ = 0;
    Parse(data, len);
    if (final) {
      FinishStream();
    }
    return emitted_rows_;
  }

  uint64_t FinishCount() { return WriteCount(nullptr, 0, true); }

  uint64_t FinishCountWhereEquals(RowFilter filter) {
    return WriteCountWhereEquals(nullptr, 0, true, filter);
  }

  uint64_t FinishCountWhereIn(RowFilter filter) {
    return WriteCountWhereIn(nullptr, 0, true, filter);
  }

  uint64_t FinishCountWhereStartsWith(RowFilter filter) {
    return WriteCountWhereStartsWith(nullptr, 0, true, filter);
  }

  void Reset() {
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
    filter_ = RowFilter{};
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
    direct_projection_filter_ = false;
    direct_projection_row_started_ = false;
    direct_projection_data_start_ = 0;
    direct_projection_field_offsets_start_ = 0;
  }

  const char *LastError() const { return error_.empty() ? "" : error_.c_str(); }

  void SetError(const char *value) { error_ = value; }

private:
  void Configure(const uint32_t *selected_columns, size_t selected_columns_len,
                 RowFilter filter) {
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
    direct_projection_filter_ = CanUseDirectProjectionFilter();
  }

  bool EnsureMultiColumnStats(const uint32_t *columns, size_t columns_len,
                              size_t input_len) {
    if (columns == nullptr && columns_len != 0) {
      SetError("multi-column stats columns are null");
      return false;
    }

    if (multi_column_stats_batch_owner_ != nullptr) {
      if (multi_column_stats_batch_owner_->columns.size() != columns_len) {
        SetError("multi-column stats columns changed during stream");
        return false;
      }
      for (size_t index = 0; index < columns_len; ++index) {
        if (multi_column_stats_batch_owner_->columns[index] != columns[index]) {
          SetError("multi-column stats columns changed during stream");
          return false;
        }
      }
      return true;
    }

    multi_column_stats_batch_owner_ =
        std::make_unique<CsvMultiColumnStatsBatch>();
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
      auto batch = std::make_unique<CsvColumnStatsBatch>();
      batch->ids.reserve((input_len / 160) + 32);
      multi_column_stats_batch_owner_->batches.push_back(std::move(batch));
      multi_column_stats_indexes_[columns[index]].push_back(index);
      multi_column_stats_hash_ids_[index].reserve(128);
    }

    return true;
  }

  void Parse(const uint8_t *data, size_t len) {
    if (data == nullptr || len == 0) {
      return;
    }

    if (mode_ == OutputMode::kCount && !filter_.enabled) {
      ParseCountOnly(data, len);
      return;
    }

    size_t i = 0;
    while (i < len) {
      if (in_quotes_) {
        if (pending_quote_) {
          if (data[i] == '"') {
            AppendDecodedByte('"');
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
        const size_t span = quote == kNpos ? len - i : quote;
        AppendDecodedSpan(data + i, span);
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
        FinishField();
        saw_row_data_ = true;
        ++i;
        continue;
      }

      if (byte == '\n' || byte == '\r') {
        FinishRow();
        previous_was_cr_ = byte == '\r';
        ++i;
        continue;
      }

      if (byte == '"' && at_field_start_) {
        const size_t close_quote =
            FindCompleteQuotedFieldClose(data + i, len - i);
        if (close_quote != kNpos) {
          AppendCompleteQuotedField(data + i, close_quote);
          const size_t terminator_index = i + close_quote + 1;
          const uint8_t terminator = data[terminator_index];
          if (terminator == delimiter_) {
            FinishField();
            saw_row_data_ = true;
            i = terminator_index + 1;
            continue;
          }
          if (terminator == '\n' || terminator == '\r') {
            FinishRow();
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

      const size_t span = FindPlainSpan(data + i, len - i);
      AppendPlainSpan(data + i, span, len - i);
      i += span;
    }
  }

  void ParseCountOnly(const uint8_t *data, size_t len) {
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
        if (quote == kNpos) {
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
        if (saw_row_data_) {
          ++emitted_rows_;
        }
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

      const size_t span = FindPlainSpan(data + i, len - i);
      saw_row_data_ = true;
      at_field_start_ = false;
      i += span;
    }
  }

  bool ParseTrustedFixedRows(const uint8_t *data, size_t len, bool final,
                             uint32_t fixed_columns) {
    size_t row_start = 0;
    while (row_start < len) {
      const size_t newline = find_byte_simd(data + row_start, len - row_start,
                                            static_cast<uint8_t>('\n'));
      if (newline == kNpos) {
        break;
      }

      size_t row_len = newline;
      if (row_len != 0 && data[row_start + row_len - 1] == '\r') {
        --row_len;
      }

      if (!trusted_row_buffer_.empty()) {
        trusted_row_buffer_.append(
            reinterpret_cast<const char *>(data + row_start), row_len);
        if (!ParseTrustedFixedBufferedRow(fixed_columns)) {
          return false;
        }
      } else if (!ParseTrustedFixedRow(data + row_start, row_len,
                                       fixed_columns)) {
        return false;
      }

      row_start += newline + 1;
    }

    if (row_start < len) {
      trusted_row_buffer_.append(
          reinterpret_cast<const char *>(data + row_start), len - row_start);
    }

    if (final && !trusted_row_buffer_.empty()) {
      if (!ParseTrustedFixedBufferedRow(fixed_columns)) {
        return false;
      }
    }

    return true;
  }

  bool ParseTrustedFixedBufferedRow(uint32_t fixed_columns) {
    size_t row_len = trusted_row_buffer_.size();
    if (row_len != 0 && trusted_row_buffer_[row_len - 1] == '\r') {
      --row_len;
    }
    const bool ok = ParseTrustedFixedRow(
        reinterpret_cast<const uint8_t *>(trusted_row_buffer_.data()), row_len,
        fixed_columns);
    trusted_row_buffer_.clear();
    return ok;
  }

  bool ParseTrustedFixedRow(const uint8_t *row, size_t len,
                            uint32_t fixed_columns) {
    if (len == 0) {
      return true;
    }
    if (batch_ == nullptr) {
      SetError("trusted fixed batch is null");
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
          const size_t span = quote == kNpos ? len - i : quote;
          AppendTrustedFixedSpan(row + i, span);
          i += span;
          if (quote == kNpos) {
            break;
          }
          ++i;
          if (i < len && row[i] == '"') {
            AppendTrustedFixedByte(static_cast<uint8_t>('"'));
            ++i;
            continue;
          }
          closed = true;
          break;
        }

        if (!closed) {
          SetError("trusted fixed quoted field is not closed before row end");
          return false;
        }
        while (i < len && row[i] != delimiter_) {
          ++i;
        }
      } else {
        const size_t delimiter = find_byte_simd(row + i, len - i, delimiter_);
        const size_t span = delimiter == kNpos ? len - i : delimiter;
        AppendTrustedFixedSpan(row + i, span);
        i += span;
      }

      FinishTrustedFixedField();
      ++parsed_columns;

      if (i >= len) {
        break;
      }

      if (row[i] != delimiter_) {
        SetError("trusted fixed row parser stopped before delimiter");
        return false;
      }
      ++i;

      if (i == len) {
        FinishTrustedFixedField();
        ++parsed_columns;
        break;
      }
    }

    if (parsed_columns != fixed_columns) {
      SetError("trusted fixed row column count mismatch");
      return false;
    }

    FinishBatchRow();
    ++emitted_rows_;
    return true;
  }

  void AppendTrustedFixedByte(uint8_t byte) {
    AppendTrustedFixedSpan(&byte, 1);
  }

  void AppendTrustedFixedSpan(const uint8_t *data, size_t len) {
    if (len == 0) {
      return;
    }
    if (encoding_ == Encoding::kUtf8) {
      batch_->data.append(reinterpret_cast<const char *>(data), len);
      return;
    }
    append_latin1(batch_->data, data, len);
  }

  void FinishTrustedFixedField() {
    batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
  }

  size_t FindPlainSpan(const uint8_t *data, size_t len) const {
    const size_t found = find_plain_special_simd(data, len, delimiter_);
    return found == kNpos ? len : found;
  }

  size_t FindCompleteQuotedFieldClose(const uint8_t *data, size_t len) const {
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
          return kNpos;
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
        return kNpos;
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
        return kNpos;
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
      return kNpos;
    }

    return kNpos;
  }

  void AppendDecodedByte(uint8_t byte) { AppendDecodedSpan(&byte, 1); }

  void AppendPlainSpan(const uint8_t *data, size_t len, size_t remaining) {
    if (CanAppendCompletePlainFieldToArena(len, remaining)) {
      AppendUtf8SpanToArena(data, len);
      return;
    }

    AppendDecodedSpan(data, len);
  }

  void AppendDecodedSpan(const uint8_t *data, size_t len) {
    if (len == 0) {
      return;
    }
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!ShouldCaptureCurrentField()) {
      return;
    }

    if (encoding_ == Encoding::kUtf8) {
      field_.append(reinterpret_cast<const char *>(data), len);
      return;
    }

    append_latin1(field_, data, len);
  }

  bool CanAppendCompletePlainFieldToArena(size_t len, size_t remaining) const {
    return mode_ == OutputMode::kBatch && encoding_ == Encoding::kUtf8 &&
           batch_ != nullptr && !UseDeferredRows() && at_field_start_ &&
           field_.empty() && !field_in_arena_ && len < remaining;
  }

  void AppendUtf8SpanToArena(const uint8_t *data, size_t len) {
    saw_row_data_ = true;
    at_field_start_ = false;
    field_in_arena_ = true;
    if (len != 0) {
      batch_->data.append(reinterpret_cast<const char *>(data), len);
    }
  }

  void AppendCompleteQuotedField(const uint8_t *data, size_t close_quote) {
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!ShouldCaptureCurrentField()) {
      return;
    }

    if (encoding_ == Encoding::kUtf8 && mode_ == OutputMode::kBatch &&
        batch_ != nullptr && !UseDeferredRows() && field_.empty() &&
        !field_in_arena_) {
      AppendQuotedFieldToArena(data, close_quote);
      return;
    }

    AppendQuotedFieldToFieldBuffer(data, close_quote);
  }

  void AppendQuotedFieldToArena(const uint8_t *data, size_t close_quote) {
    field_in_arena_ = true;
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

  void AppendQuotedFieldToFieldBuffer(const uint8_t *data, size_t close_quote) {
    if (!complete_quoted_field_has_escape_) {
      AppendDecodedSpan(data + 1, close_quote - 1);
      return;
    }

    size_t segment_start = 1;
    for (size_t i = 1; i < close_quote; ++i) {
      if (data[i] == '"' && i + 1 < close_quote && data[i + 1] == '"') {
        AppendDecodedSpan(data + segment_start, i - segment_start);
        AppendDecodedByte('"');
        ++i;
        segment_start = i + 1;
      }
    }
    AppendDecodedSpan(data + segment_start, close_quote - segment_start);
  }

  void FinishField() {
    if (UseDeferredRows()) {
      FinishDeferredField();
    } else if (mode_ == OutputMode::kDictionary) {
      FinishDictionaryField();
    } else if (mode_ == OutputMode::kGroupByCount) {
      FinishGroupByCountField();
    } else if (mode_ == OutputMode::kColumnStats) {
      FinishColumnStatsField();
    } else if (mode_ == OutputMode::kMultiColumnStats) {
      FinishMultiColumnStatsField();
    } else if (mode_ == OutputMode::kBatch && batch_ != nullptr) {
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

  void FinishRow() {
    if (!saw_row_data_) {
      at_field_start_ = true;
      return;
    }

    FinishField();
    const bool emit_row =
        !filter_.enabled || (row_filter_seen_ && row_filter_matched_);
    if (mode_ == OutputMode::kBatch && emit_row) {
      if (direct_projection_filter_) {
        FinishBatchRow();
      } else if (UseDeferredRows()) {
        CommitDeferredBatchRow();
      } else {
        FinishBatchRow();
      }
    } else if (mode_ == OutputMode::kBatch && direct_projection_filter_) {
      RollbackDirectProjectionRow();
    }
    if (mode_ == OutputMode::kDictionary) {
      FinishDictionaryRow();
    }
    if (mode_ == OutputMode::kGroupByCount) {
      FinishGroupByCountRow();
    }
    if (mode_ == OutputMode::kColumnStats) {
      FinishColumnStatsRow();
    }
    if (mode_ == OutputMode::kMultiColumnStats) {
      FinishMultiColumnStatsRow();
    }
    if (emit_row) {
      ++emitted_rows_;
    }
    ResetRowState();
    saw_row_data_ = false;
    at_field_start_ = true;
  }

  bool UseDeferredRows() const {
    return projection_enabled_ || filter_.enabled || fixed_columns_enabled_;
  }

  bool ShouldCaptureCurrentField() const {
    if (mode_ == OutputMode::kCount) {
      return filter_.enabled && current_column_ == filter_.column;
    }

    if (mode_ == OutputMode::kDictionary) {
      return current_column_ == dictionary_column_;
    }

    if (mode_ == OutputMode::kGroupByCount) {
      return current_column_ == group_by_column_;
    }

    if (mode_ == OutputMode::kColumnStats) {
      return current_column_ == column_stats_column_;
    }

    if (mode_ == OutputMode::kMultiColumnStats) {
      return multi_column_stats_indexes_.find(current_column_) !=
             multi_column_stats_indexes_.end();
    }

    if (!UseDeferredRows()) {
      return true;
    }

    return ShouldStoreCurrentField() ||
           (filter_.enabled && current_column_ == filter_.column);
  }

  bool ShouldStoreCurrentField() const {
    return !projection_enabled_ || selected_output_count(current_column_) > 0;
  }

  bool CanUseDirectProjectionFilter() const {
    if (mode_ != OutputMode::kBatch || !projection_enabled_ ||
        !filter_.enabled || selected_columns_len_ == 0) {
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

  void FinishDeferredField() {
    if (direct_projection_filter_) {
      FinishDirectProjectionField();
      return;
    }

    if (filter_.enabled && current_column_ == filter_.column) {
      row_filter_seen_ = true;
      row_filter_matched_ = FieldMatchesFilter();
    }

    if (mode_ != OutputMode::kBatch) {
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

  void FinishDirectProjectionField() {
    if (filter_.enabled && current_column_ == filter_.column) {
      row_filter_seen_ = true;
      row_filter_matched_ = FieldMatchesFilter();
    }

    if (batch_ == nullptr || !ShouldStoreCurrentField()) {
      return;
    }

    if (!direct_projection_row_started_) {
      direct_projection_row_started_ = true;
      direct_projection_data_start_ = batch_->data.size();
      direct_projection_field_offsets_start_ = batch_->field_offsets.size();
    }

    batch_->data.append(field_);
    batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
  }

  void RollbackDirectProjectionRow() {
    if (batch_ == nullptr || !direct_projection_row_started_) {
      return;
    }
    batch_->data.resize(direct_projection_data_start_);
    batch_->field_offsets.resize(direct_projection_field_offsets_start_);
  }

  bool FieldMatchesFilter() const {
    switch (filter_.kind) {
    case RowFilterKind::kEquals:
      return FieldEqualsFilter(filter_.value, filter_.value_len);
    case RowFilterKind::kIn:
      return FieldInFilter();
    case RowFilterKind::kStartsWith:
      return FieldStartsWithFilter();
    case RowFilterKind::kNone:
      return true;
    }
    return false;
  }

  bool FieldEqualsFilter(const uint8_t *value, size_t value_len) const {
    if (field_.size() != value_len) {
      return false;
    }
    if (value_len == 0) {
      return true;
    }
    return std::memcmp(field_.data(), value, value_len) == 0;
  }

  bool FieldInFilter() const {
    if (filter_.value_offsets == nullptr || filter_.values_data == nullptr) {
      return false;
    }
    for (size_t index = 0; index < filter_.value_count; ++index) {
      const uint32_t start = filter_.value_offsets[index];
      const uint32_t end = filter_.value_offsets[index + 1];
      if (FieldEqualsFilter(filter_.values_data + start, end - start)) {
        return true;
      }
    }
    return false;
  }

  bool FieldStartsWithFilter() const {
    if (field_.size() < filter_.value_len) {
      return false;
    }
    if (filter_.value_len == 0) {
      return true;
    }
    return std::memcmp(field_.data(), filter_.value, filter_.value_len) == 0;
  }

  void FinishDictionaryField() {
    if (dictionary_batch_ != nullptr && current_column_ == dictionary_column_) {
      dictionary_row_seen_ = true;
      dictionary_row_id_ = InternDictionaryValue(
          *dictionary_batch_, dictionary_hash_ids_, dictionary_hash_collisions_,
          field_.data(), field_.size());
    }
  }

  void FinishDictionaryRow() {
    if (dictionary_batch_ == nullptr) {
      return;
    }
    if (!dictionary_row_seen_) {
      dictionary_row_id_ =
          InternDictionaryValue(*dictionary_batch_, dictionary_hash_ids_,
                                dictionary_hash_collisions_, nullptr, 0);
    }
    dictionary_batch_->ids.push_back(dictionary_row_id_);
  }

  void FinishGroupByCountField() {
    if (group_by_count_batch_ != nullptr &&
        current_column_ == group_by_column_) {
      group_by_row_seen_ = true;
      group_by_row_id_ = InternGroupByCountValue(
          *group_by_count_batch_, group_by_hash_ids_, group_by_hash_collisions_,
          field_.data(), field_.size());
    }
  }

  void FinishGroupByCountRow() {
    if (group_by_count_batch_ == nullptr) {
      return;
    }
    if (!group_by_row_seen_) {
      group_by_row_id_ =
          InternGroupByCountValue(*group_by_count_batch_, group_by_hash_ids_,
                                  group_by_hash_collisions_, nullptr, 0);
    }
    ++group_by_count_batch_->counts[group_by_row_id_];
    ++group_by_count_batch_->row_count;
  }

  void FinishColumnStatsField() {
    if (column_stats_batch_ != nullptr &&
        current_column_ == column_stats_column_) {
      column_stats_row_seen_ = true;
      column_stats_row_id_ = InternColumnStatsValue(
          *column_stats_batch_, column_stats_hash_ids_,
          column_stats_hash_collisions_, field_.data(), field_.size());
    }
  }

  void FinishColumnStatsRow() {
    if (column_stats_batch_ == nullptr) {
      return;
    }
    if (!column_stats_row_seen_) {
      column_stats_row_id_ =
          InternColumnStatsValue(*column_stats_batch_, column_stats_hash_ids_,
                                 column_stats_hash_collisions_, nullptr, 0);
    }
    column_stats_batch_->ids.push_back(column_stats_row_id_);
    ++column_stats_batch_->counts[column_stats_row_id_];
  }

  void FinishMultiColumnStatsField() {
    if (multi_column_stats_batch_owner_ == nullptr) {
      return;
    }

    const auto found = multi_column_stats_indexes_.find(current_column_);
    if (found == multi_column_stats_indexes_.end()) {
      return;
    }

    for (const size_t index : found->second) {
      multi_column_stats_row_seen_[index] = true;
      multi_column_stats_row_ids_[index] = InternColumnStatsValue(
          *multi_column_stats_batch_owner_->batches[index],
          multi_column_stats_hash_ids_[index],
          multi_column_stats_hash_collisions_[index], field_.data(),
          field_.size());
    }
  }

  void FinishMultiColumnStatsRow() {
    if (multi_column_stats_batch_owner_ == nullptr) {
      return;
    }

    for (size_t index = 0;
         index < multi_column_stats_batch_owner_->batches.size(); ++index) {
      auto &batch = *multi_column_stats_batch_owner_->batches[index];
      if (!multi_column_stats_row_seen_[index]) {
        multi_column_stats_row_ids_[index] = InternColumnStatsValue(
            batch, multi_column_stats_hash_ids_[index],
            multi_column_stats_hash_collisions_[index], nullptr, 0);
      }
      batch.ids.push_back(multi_column_stats_row_ids_[index]);
      ++batch.counts[multi_column_stats_row_ids_[index]];
    }
  }

  void CommitDeferredBatchRow() {
    if (batch_ == nullptr) {
      return;
    }

    if (projection_enabled_) {
      CommitFields(projected_fields_);
    } else {
      CommitFields(row_fields_);
    }
  }

  void CommitFields(const std::vector<std::string> &fields) {
    if (batch_ == nullptr) {
      return;
    }

    for (const auto &field : fields) {
      batch_->data.append(field);
      batch_->field_offsets.push_back(checked_u32(batch_->data.size()));
    }
    FinishBatchRow();
  }

  void ResetRowState() {
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
    direct_projection_row_started_ = false;
    direct_projection_data_start_ = 0;
    direct_projection_field_offsets_start_ = 0;
  }

  void FinishBatchRow() {
    if (batch_ == nullptr) {
      return;
    }

    if (fixed_columns_enabled_) {
      const uint32_t row_start = batch_->row_offsets.back();
      const size_t row_end = batch_->field_offsets.size() - 1;
      const size_t field_count = row_end - row_start;
      if (field_count != fixed_columns_) {
        SetError("fixed row column count mismatch");
        parse_failed_ = true;
        return;
      }
    }

    batch_->row_offsets.push_back(
        checked_u32(batch_->field_offsets.size() - 1));
  }

  void FinishStream() {
    if (pending_quote_) {
      pending_quote_ = false;
      in_quotes_ = false;
    }
    if (in_quotes_) {
      in_quotes_ = false;
    }
    if (saw_row_data_) {
      FinishRow();
    }
  }

  static uint32_t checked_u32(size_t value) {
    if (value > std::numeric_limits<uint32_t>::max()) {
      return std::numeric_limits<uint32_t>::max();
    }
    return static_cast<uint32_t>(value);
  }

  static uint32_t InternDictionaryValue(
      CsvDictionaryBatch &dictionary,
      std::unordered_map<uint64_t, uint32_t> &hash_ids,
      std::unordered_map<uint64_t, std::vector<uint32_t>> &hash_collisions,
      const char *value, size_t value_len) {
    const char *actual = value == nullptr ? "" : value;
    const uint64_t hash = HashBytes(actual, value_len);
    const auto found = hash_ids.find(hash);
    if (found != hash_ids.end()) {
      if (DictionaryValueEquals(dictionary, found->second, actual, value_len)) {
        return found->second;
      }

      const auto collisions = hash_collisions.find(hash);
      if (collisions != hash_collisions.end()) {
        for (const uint32_t id : collisions->second) {
          if (DictionaryValueEquals(dictionary, id, actual, value_len)) {
            return id;
          }
        }
      }

      const uint32_t id = AppendDictionaryValue(dictionary, actual, value_len);
      hash_collisions[hash].push_back(id);
      return id;
    }

    const uint32_t id = AppendDictionaryValue(dictionary, actual, value_len);
    hash_ids.emplace(hash, id);
    return id;
  }

  static uint32_t AppendDictionaryValue(CsvDictionaryBatch &dictionary,
                                        const char *value, size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    return id;
  }

  static bool DictionaryValueEquals(const CsvDictionaryBatch &dictionary,
                                    uint32_t id, const char *value,
                                    size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return BytesEqual(dictionary.dict_data.data() + start, end - start, value,
                      value_len);
  }

  static uint32_t InternGroupByCountValue(
      CsvGroupByCountBatch &dictionary,
      std::unordered_map<uint64_t, uint32_t> &hash_ids,
      std::unordered_map<uint64_t, std::vector<uint32_t>> &hash_collisions,
      const char *value, size_t value_len) {
    const char *actual = value == nullptr ? "" : value;
    const uint64_t hash = HashBytes(actual, value_len);
    const auto found = hash_ids.find(hash);
    if (found != hash_ids.end()) {
      if (GroupByCountValueEquals(dictionary, found->second, actual,
                                  value_len)) {
        return found->second;
      }

      const auto collisions = hash_collisions.find(hash);
      if (collisions != hash_collisions.end()) {
        for (const uint32_t id : collisions->second) {
          if (GroupByCountValueEquals(dictionary, id, actual, value_len)) {
            return id;
          }
        }
      }

      const uint32_t id =
          AppendGroupByCountValue(dictionary, actual, value_len);
      hash_collisions[hash].push_back(id);
      return id;
    }

    const uint32_t id = AppendGroupByCountValue(dictionary, actual, value_len);
    hash_ids.emplace(hash, id);
    return id;
  }

  static uint32_t AppendGroupByCountValue(CsvGroupByCountBatch &dictionary,
                                          const char *value, size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    dictionary.counts.push_back(0);
    return id;
  }

  static bool GroupByCountValueEquals(const CsvGroupByCountBatch &dictionary,
                                      uint32_t id, const char *value,
                                      size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return BytesEqual(dictionary.dict_data.data() + start, end - start, value,
                      value_len);
  }

  static uint32_t InternColumnStatsValue(
      CsvColumnStatsBatch &dictionary,
      std::unordered_map<uint64_t, uint32_t> &hash_ids,
      std::unordered_map<uint64_t, std::vector<uint32_t>> &hash_collisions,
      const char *value, size_t value_len) {
    const char *actual = value == nullptr ? "" : value;
    const uint64_t hash = HashBytes(actual, value_len);
    const auto found = hash_ids.find(hash);
    if (found != hash_ids.end()) {
      if (ColumnStatsValueEquals(dictionary, found->second, actual,
                                 value_len)) {
        return found->second;
      }

      const auto collisions = hash_collisions.find(hash);
      if (collisions != hash_collisions.end()) {
        for (const uint32_t id : collisions->second) {
          if (ColumnStatsValueEquals(dictionary, id, actual, value_len)) {
            return id;
          }
        }
      }

      const uint32_t id = AppendColumnStatsValue(dictionary, actual, value_len);
      hash_collisions[hash].push_back(id);
      return id;
    }

    const uint32_t id = AppendColumnStatsValue(dictionary, actual, value_len);
    hash_ids.emplace(hash, id);
    return id;
  }

  static uint32_t AppendColumnStatsValue(CsvColumnStatsBatch &dictionary,
                                         const char *value, size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    dictionary.counts.push_back(0);
    return id;
  }

  static bool ColumnStatsValueEquals(const CsvColumnStatsBatch &dictionary,
                                     uint32_t id, const char *value,
                                     size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return BytesEqual(dictionary.dict_data.data() + start, end - start, value,
                      value_len);
  }

  static uint64_t HashBytes(const char *data, size_t len) {
    uint64_t hash = 1469598103934665603ull;
    for (size_t index = 0; index < len; ++index) {
      hash ^= static_cast<uint8_t>(data[index]);
      hash *= 1099511628211ull;
    }
    return hash;
  }

  static bool BytesEqual(const char *left, size_t left_len, const char *right,
                         size_t right_len) {
    return left_len == right_len &&
           (left_len == 0 || std::memcmp(left, right, left_len) == 0);
  }

  Encoding encoding_;
  uint8_t delimiter_;
  OutputMode mode_ = OutputMode::kBatch;
  CsvBatch *batch_ = nullptr;
  CsvDictionaryBatch *dictionary_batch_ = nullptr;
  CsvGroupByCountBatch *group_by_count_batch_ = nullptr;
  std::unique_ptr<CsvGroupByCountBatch> group_by_count_batch_owner_;
  CsvColumnStatsBatch *column_stats_batch_ = nullptr;
  std::unique_ptr<CsvColumnStatsBatch> column_stats_batch_owner_;
  std::unique_ptr<CsvMultiColumnStatsBatch> multi_column_stats_batch_owner_;
  const uint32_t *selected_columns_ = nullptr;
  size_t selected_columns_len_ = 0;
  std::vector<uint8_t> selected_column_counts_;
  std::vector<std::vector<uint32_t>> selected_column_outputs_;
  bool projection_enabled_ = false;
  bool direct_projection_filter_ = false;
  bool fixed_columns_enabled_ = false;
  uint32_t fixed_columns_ = 0;
  bool parse_failed_ = false;
  bool direct_projection_row_started_ = false;
  size_t direct_projection_data_start_ = 0;
  size_t direct_projection_field_offsets_start_ = 0;
  RowFilter filter_;
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
  uint64_t emitted_rows_ = 0;
};

CsvParser *checked_parser(void *parser) {
  return static_cast<CsvParser *>(parser);
}

CsvBatch *checked_batch(void *batch) { return static_cast<CsvBatch *>(batch); }

CsvDictionaryBatch *checked_dictionary_batch(void *batch) {
  return static_cast<CsvDictionaryBatch *>(batch);
}

CsvGroupByCountBatch *checked_group_by_count_batch(void *batch) {
  return static_cast<CsvGroupByCountBatch *>(batch);
}

CsvColumnStatsBatch *checked_column_stats_batch(void *batch) {
  return static_cast<CsvColumnStatsBatch *>(batch);
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

CsvMultiColumnStatsBatch *checked_multi_column_stats_batch(void *batch) {
  return static_cast<CsvMultiColumnStatsBatch *>(batch);
}

} // namespace csv_native

CSV_EXPORT void *csv_parser_create(int encoding, uint8_t delimiter) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' ||
      delimiter == '"') {
    return nullptr;
  }
  const auto selected = encoding == 1 ? csv_native::Encoding::kLatin1
                                      : csv_native::Encoding::kUtf8;
  return new csv_native::CsvParser(selected, delimiter);
}

CSV_EXPORT void csv_parser_destroy(void *parser) {
  delete csv_native::checked_parser(parser);
}

CSV_EXPORT void csv_parser_reset(void *parser) {
  if (parser == nullptr) {
    return;
  }
  csv_native::checked_parser(parser)->Reset();
}

CSV_EXPORT void *csv_parser_write_batch(void *parser, const uint8_t *data,
                                        uint64_t len, bool final) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->WriteBatch(
      data, static_cast<size_t>(len), final);
}

CSV_EXPORT void *csv_parser_finish_batch(void *parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishBatch();
}

CSV_EXPORT void *csv_parser_write_fixed_batch(void *parser, const uint8_t *data,
                                              uint64_t len, bool final,
                                              uint32_t fixed_columns) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->WriteFixedBatch(
      data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void *csv_parser_finish_fixed_batch(void *parser,
                                               uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishFixedBatch(fixed_columns);
}

CSV_EXPORT void *csv_parser_write_trusted_fixed_batch(void *parser,
                                                      const uint8_t *data,
                                                      uint64_t len, bool final,
                                                      uint32_t fixed_columns) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->WriteTrustedFixedBatch(
      data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void *csv_parser_finish_trusted_fixed_batch(void *parser,
                                                       uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishTrustedFixedBatch(
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

  return csv_native::checked_parser(parser)->WriteProjectedBatch(
      data, static_cast<size_t>(len), final,
      has_projection ? selected_columns : nullptr,
      has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::RowFilter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::RowFilterKind::kEquals
                             : csv_native::RowFilterKind::kNone,
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

  return csv_native::checked_parser(parser)->FinishProjectedBatch(
      has_projection ? selected_columns : nullptr,
      has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::RowFilter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::RowFilterKind::kEquals
                             : csv_native::RowFilterKind::kNone,
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

  return csv_native::checked_parser(parser)->WriteDictionaryBatch(
      data, static_cast<size_t>(len), final, column);
}

CSV_EXPORT void *csv_parser_finish_dictionary_batch(void *parser,
                                                    uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishDictionaryBatch(column);
}

CSV_EXPORT uint64_t csv_parser_write_group_by_count(void *parser,
                                                    const uint8_t *data,
                                                    uint64_t len,
                                                    uint32_t column) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->WriteGroupByCount(
      data, static_cast<size_t>(len), column);
}

CSV_EXPORT void *csv_parser_finish_group_by_count(void *parser,
                                                  uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishGroupByCount(column);
}

CSV_EXPORT uint64_t csv_parser_write_column_stats(void *parser,
                                                  const uint8_t *data,
                                                  uint64_t len,
                                                  uint32_t column) {
  if (parser == nullptr ||
      len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->WriteColumnStats(
      data, static_cast<size_t>(len), column);
}

CSV_EXPORT void *csv_parser_finish_column_stats(void *parser, uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishColumnStats(column);
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

  return csv_native::checked_parser(parser)->WriteMultiColumnStats(
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

  return csv_native::checked_parser(parser)->FinishMultiColumnStats(
      columns, static_cast<size_t>(columns_len));
}

CSV_EXPORT void csv_batch_destroy(void *batch) {
  delete static_cast<csv_native::CsvBatch *>(batch);
}

CSV_EXPORT void csv_dictionary_batch_destroy(void *batch) {
  delete static_cast<csv_native::CsvDictionaryBatch *>(batch);
}

CSV_EXPORT void csv_group_by_count_batch_destroy(void *batch) {
  delete static_cast<csv_native::CsvGroupByCountBatch *>(batch);
}

CSV_EXPORT void csv_column_stats_batch_destroy(void *batch) {
  delete static_cast<csv_native::CsvColumnStatsBatch *>(batch);
}

CSV_EXPORT void csv_multi_column_stats_batch_destroy(void *batch) {
  delete static_cast<csv_native::CsvMultiColumnStatsBatch *>(batch);
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
  const auto *typed = static_cast<const csv_native::CsvBatch *>(batch);
  return typed->row_offsets.empty() ? 0 : typed->row_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_total_fields(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto *typed = static_cast<const csv_native::CsvBatch *>(batch);
  return typed->field_offsets.empty() ? 0 : typed->field_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_data_len(void *batch) {
  if (batch == nullptr) {
    return 0;
  }
  return static_cast<const csv_native::CsvBatch *>(batch)->data.size();
}

CSV_EXPORT const uint8_t *csv_batch_data_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto *typed = static_cast<const csv_native::CsvBatch *>(batch);
  return reinterpret_cast<const uint8_t *>(typed->data.data());
}

CSV_EXPORT const uint32_t *csv_batch_row_offsets_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::CsvBatch *>(batch)->row_offsets.data();
}

CSV_EXPORT const uint32_t *csv_batch_field_offsets_ptr(void *batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::CsvBatch *>(batch)->field_offsets.data();
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

  return csv_native::checked_parser(parser)->WriteCount(
      data, static_cast<size_t>(len), final);
}

CSV_EXPORT uint64_t csv_parser_count_trusted_newlines(const uint8_t *data,
                                                      uint64_t len) {
  if (len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::count_trusted_newlines(data, static_cast<size_t>(len));
}

CSV_EXPORT uint64_t csv_parser_finish_count(void *parser) {
  if (parser == nullptr) {
    return 0;
  }

  return csv_native::checked_parser(parser)->FinishCount();
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

  return csv_native::checked_parser(parser)->WriteCountWhereEquals(
      data, static_cast<size_t>(len), final,
      csv_native::RowFilter{
          .enabled = true,
          .kind = csv_native::RowFilterKind::kEquals,
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

  return csv_native::checked_parser(parser)->WriteCountWhereIn(
      data, static_cast<size_t>(len), final,
      csv_native::RowFilter{
          .enabled = true,
          .kind = csv_native::RowFilterKind::kIn,
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

  return csv_native::checked_parser(parser)->WriteCountWhereStartsWith(
      data, static_cast<size_t>(len), final,
      csv_native::RowFilter{
          .enabled = true,
          .kind = csv_native::RowFilterKind::kStartsWith,
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

  return csv_native::checked_parser(parser)->FinishCountWhereEquals(
      csv_native::RowFilter{
          .enabled = true,
          .kind = csv_native::RowFilterKind::kEquals,
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

  return csv_native::checked_parser(parser)->FinishCountWhereIn(
      csv_native::RowFilter{
          .enabled = true,
          .kind = csv_native::RowFilterKind::kIn,
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

  return csv_native::checked_parser(parser)->FinishCountWhereStartsWith(
      csv_native::RowFilter{
          .enabled = true,
          .kind = csv_native::RowFilterKind::kStartsWith,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT const char *csv_parser_last_error(void *parser) {
  if (parser == nullptr) {
    return "parser is null";
  }
  return csv_native::checked_parser(parser)->LastError();
}
