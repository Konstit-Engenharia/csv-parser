#include <ankerl/unordered_dense.h>
#include <hwy/highway.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <string>
#include <vector>

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
  const uint8_t* value = nullptr;
  size_t value_len = 0;
  const uint8_t* values_data = nullptr;
  const uint32_t* value_offsets = nullptr;
  size_t value_count = 0;
};

struct csv_batch {
  std::vector<uint64_t> row_offsets{0};
  std::vector<uint64_t> field_offsets{0};
  std::string data;

  void reserve(size_t input_len, csv_encoding encoding) {
    const size_t data_capacity = encoding == csv_encoding::latin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    field_offsets.reserve((input_len / 6) + 32);
    row_offsets.reserve((input_len / 160) + 32);
  }

  void reserve_fixed(size_t input_len, csv_encoding encoding, uint32_t fixed_columns) {
    const size_t data_capacity = encoding == csv_encoding::latin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    const size_t rows_hint = (input_len / 160) + 32;
    field_offsets.reserve(rows_hint * static_cast<size_t>(fixed_columns) + 1);
    row_offsets.reserve(rows_hint + 1);
  }
};

struct csv_split_offsets_batch {
  std::vector<uint64_t> offsets;
};

constexpr size_t npos = std::numeric_limits<size_t>::max();
constexpr uint32_t max_column_index = 2024;
constexpr uint64_t max_projection_length = 2024;

struct csv_structural_state {
  bool in_quotes = false;
  bool pending_quote = false;
  bool at_field_start = true;
  bool previous_was_cr = false;
  bool saw_row_data = false;
  uint64_t deferred_cr_row_end = 0;
};

template <bool defer_crlf, typename OnRowEnd>
HWY_ATTR bool scan_csv_row_ends(const uint8_t* data, size_t len, uint8_t delimiter, uint64_t base_offset,
                                csv_structural_state& state, OnRowEnd&& on_row_end) {
  // BitsFromMask exposes one bit per lane in a uint64_t, so keep blocks at most 64 bytes wide.
  const hn::CappedTag<uint8_t, 64> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto quote_v = hn::Set(du8, static_cast<uint8_t>('"'));
  const auto lf_v = hn::Set(du8, static_cast<uint8_t>('\n'));
  const auto cr_v = hn::Set(du8, static_cast<uint8_t>('\r'));

  for (size_t block_start = 0; block_start < len; block_start += lanes) {
    const size_t block_size = std::min(lanes, len - block_start);
    const auto bytes =
        block_size == lanes ? hn::LoadU(du8, data + block_start) : hn::LoadN(du8, data + block_start, block_size);
    const auto quote_mask = hn::Eq(bytes, quote_v);
    const auto row_end_mask = hn::Or(hn::Eq(bytes, lf_v), hn::Eq(bytes, cr_v));
    // Delimiters only affect whether a later quote opens a field. The byte immediately before that
    // quote is sufficient, which keeps common delimiter-heavy CSV data out of the scalar event loop.
    const auto special_mask = hn::Or(quote_mask, row_end_mask);
    const uint64_t valid_bits =
        block_size == 64 ? std::numeric_limits<uint64_t>::max() : (uint64_t{1} << block_size) - 1;
    const uint64_t quote_bits = hn::BitsFromMask(du8, quote_mask) & valid_bits;
    const uint64_t special_bits = hn::BitsFromMask(du8, special_mask) & valid_bits;
    size_t cursor = 0;

    while (cursor < block_size) {
      if (state.in_quotes) {
        if (state.pending_quote) {
          if (data[block_start + cursor] == '"') {
            state.pending_quote = false;
            state.saw_row_data = true;
            state.at_field_start = false;
            ++cursor;
            continue;
          }
          state.pending_quote = false;
          state.in_quotes = false;
          continue;
        }

        const uint64_t candidates = quote_bits & (std::numeric_limits<uint64_t>::max() << cursor);
        state.saw_row_data = true;
        state.at_field_start = false;
        if (candidates == 0) {
          cursor = block_size;
          continue;
        }

        cursor = hwy::Num0BitsBelowLS1Bit_Nonzero64(candidates) + 1;
        state.pending_quote = true;
        continue;
      }

      if (state.previous_was_cr) {
        state.previous_was_cr = false;
        if (data[block_start + cursor] == '\n') {
          if constexpr (defer_crlf) {
            const uint64_t row_end = state.deferred_cr_row_end + 1;
            state.deferred_cr_row_end = 0;
            if (!on_row_end(row_end)) {
              return false;
            }
          }
          ++cursor;
          continue;
        }
        if constexpr (defer_crlf) {
          const uint64_t row_end = state.deferred_cr_row_end;
          state.deferred_cr_row_end = 0;
          if (!on_row_end(row_end)) {
            return false;
          }
        }
      }

      const uint64_t candidates = special_bits & (std::numeric_limits<uint64_t>::max() << cursor);
      if (candidates == 0) {
        state.saw_row_data = true;
        state.at_field_start = data[block_start + block_size - 1] == delimiter;
        cursor = block_size;
        continue;
      }

      const size_t event = hwy::Num0BitsBelowLS1Bit_Nonzero64(candidates);
      if (event > cursor) {
        state.saw_row_data = true;
        state.at_field_start = data[block_start + event - 1] == delimiter;
      }

      const uint8_t byte = data[block_start + event];
      cursor = event + 1;
      if (byte == '"') {
        if (state.at_field_start) {
          state.in_quotes = true;
          state.pending_quote = false;
        }
        state.saw_row_data = true;
        state.at_field_start = false;
        continue;
      }
      state.saw_row_data = false;
      state.at_field_start = true;
      state.previous_was_cr = byte == '\r';
      const uint64_t row_end = base_offset + block_start + event + 1;
      if constexpr (defer_crlf) {
        // Safe file splits must include a following LF instead of landing inside a CRLF pair.
        if (state.previous_was_cr) {
          state.deferred_cr_row_end = row_end;
          continue;
        }
      }
      if (!on_row_end(row_end)) {
        return false;
      }
    }
  }

  return true;
}

HWY_ATTR uint64_t count_trusted_newlines(const uint8_t* data, size_t len) {
  if (data == nullptr || len == 0) {
    return 0;
  }

  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto newline = hn::Set(du8, static_cast<uint8_t>('\n'));
  uint64_t rows = 0;
  size_t i = 0;
  for (; i + lanes <= len; i += lanes) {
    const auto bytes = hn::LoadU(du8, data + i);
    rows += static_cast<uint64_t>(hn::CountTrue(du8, hn::Eq(bytes, newline)));
  }
  for (; i < len; ++i) {
    rows += data[i] == '\n' ? 1 : 0;
  }
  if (data[len - 1] != '\n' && data[len - 1] != '\r') {
    ++rows;
  }
  return rows;
}

std::unique_ptr<csv_split_offsets_batch> find_csv_safe_split_offsets(const char* path, size_t shard_count,
                                                                     uint8_t delimiter) {
  if (path == nullptr || path[0] == '\0' || shard_count == 0 || delimiter == 0 || delimiter == '\n' ||
      delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }

  std::FILE* file = std::fopen(path, "rb");
  if (file == nullptr) {
    return nullptr;
  }

  if (std::fseek(file, 0, SEEK_END) != 0) {
    std::fclose(file);
    return nullptr;
  }
  const int64_t size_long = std::ftell(file);
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
    targets.push_back((file_size * static_cast<uint64_t>(shard_index)) / static_cast<uint64_t>(shard_count));
  }
  if (targets.empty()) {
    batch->offsets.push_back(file_size);
    std::fclose(file);
    return batch;
  }

  std::vector<uint8_t> buffer(8 * 1024 * 1024);
  size_t target_index = 0;
  uint64_t absolute = 0;
  csv_structural_state state;
  const auto on_row_end = [&](uint64_t row_end) {
    bool crossed_target = false;
    while (target_index < targets.size() && row_end >= targets[target_index]) {
      crossed_target = true;
      ++target_index;
    }
    if (crossed_target && row_end > batch->offsets.back()) {
      batch->offsets.push_back(row_end);
    }
    return target_index < targets.size();
  };

  while (target_index < targets.size()) {
    const size_t bytes_read = std::fread(buffer.data(), 1, buffer.size(), file);
    if (bytes_read == 0) {
      break;
    }

    if (!scan_csv_row_ends<true>(buffer.data(), bytes_read, delimiter, absolute, state, on_row_end)) {
      break;
    }
    absolute += static_cast<uint64_t>(bytes_read);
  }

  if (target_index < targets.size() && state.previous_was_cr) {
    state.previous_was_cr = false;
    const uint64_t row_end = state.deferred_cr_row_end;
    state.deferred_cr_row_end = 0;
    on_row_end(row_end);
  }

  std::fclose(file);

  if (batch->offsets.back() != file_size) {
    batch->offsets.push_back(file_size);
  }
  return batch;
}

void append_latin1_scalar(std::string& out, const uint8_t* data, size_t len) {
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

void append_latin1_scalar_byte(std::string& out, uint8_t byte) {
  if (byte < 0x80) {
    out.push_back(static_cast<char>(byte));
  } else {
    out.push_back(static_cast<char>(0xC0 | (byte >> 6)));
    out.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
  }
}

HWY_ATTR void append_latin1(std::string& out, const uint8_t* data, size_t len) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto limit = hn::Set(du8, static_cast<uint8_t>(0x80));
  const auto leading_bits = hn::Set(du8, static_cast<uint8_t>(0xC0));
  const auto trailing_mask = hn::Set(du8, static_cast<uint8_t>(0x3F));
  const auto trailing_bits = hn::Set(du8, static_cast<uint8_t>(0x80));
  size_t i = 0;

  while (i < len) {
    if (i + lanes <= len) {
      const auto bytes = hn::LoadU(du8, data + i);
      const auto ascii = hn::Lt(bytes, limit);
      if (hn::AllTrue(du8, ascii)) {
        out.append(reinterpret_cast<const char*>(data + i), lanes);
        i += lanes;
        continue;
      }

      if (hn::AllFalse(du8, ascii)) {
        const auto leading = hn::Or(hn::ShiftRight<6>(bytes), leading_bits);
        const auto trailing = hn::Or(hn::And(bytes, trailing_mask), trailing_bits);
        const size_t offset = out.size();
        out.resize(offset + lanes * 2);
        hn::StoreInterleaved2(leading, trailing, du8, reinterpret_cast<uint8_t*>(out.data() + offset));
        i += lanes;
        continue;
      }

      const intptr_t first_non_ascii = hn::FindFirstTrue(du8, hn::Not(ascii));
      if (first_non_ascii > 0) {
        out.append(reinterpret_cast<const char*>(data + i), static_cast<size_t>(first_non_ascii));
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

HWY_ATTR size_t find_byte_simd(const uint8_t* data, size_t len, uint8_t needle) {
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

HWY_ATTR size_t find_plain_special_simd(const uint8_t* data, size_t len, uint8_t delimiter) {
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
    const intptr_t found = hn::FindFirstTrue(du8, hn::Or(delimiter_mask, newline_mask));
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

HWY_ATTR size_t find_strict_plain_special_simd(const uint8_t* data, size_t len, uint8_t delimiter) {
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
    const intptr_t found = hn::FindFirstTrue(du8, hn::Or(hn::Or(delimiter_mask, quote_mask), newline_mask));
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
  csv_parser(csv_encoding encoding, uint8_t delimiter) : encoding_(encoding), delimiter_(delimiter) {}

  csv_batch* write_batch(const uint8_t* data, size_t len, bool final) {
    return write_batch_impl(data, len, final, false);
  }

  csv_batch* write_strict_batch(const uint8_t* data, size_t len, bool final) {
    return write_batch_impl(data, len, final, true);
  }

  csv_batch* write_fixed_batch(const uint8_t* data, size_t len, bool final, uint32_t fixed_columns) {
    return write_fixed_batch_impl(data, len, final, fixed_columns, false);
  }

  csv_batch* write_strict_fixed_batch(const uint8_t* data, size_t len, bool final, uint32_t fixed_columns) {
    return write_fixed_batch_impl(data, len, final, fixed_columns, true);
  }

  csv_batch* write_fixed_batch_impl(const uint8_t* data, size_t len, bool final, uint32_t fixed_columns, bool strict) {
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

  csv_batch* write_projected_batch(const uint8_t* data, size_t len, bool final, const uint32_t* selected_columns,
                                   size_t selected_columns_len, row_filter filter) {
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

  csv_batch* finish_batch() { return write_batch(nullptr, 0, true); }

  csv_batch* finish_strict_batch() { return write_strict_batch(nullptr, 0, true); }

  csv_batch* finish_fixed_batch(uint32_t fixed_columns) { return write_fixed_batch(nullptr, 0, true, fixed_columns); }

  csv_batch* finish_strict_fixed_batch(uint32_t fixed_columns) {
    return write_strict_fixed_batch(nullptr, 0, true, fixed_columns);
  }

  csv_batch* finish_projected_batch(const uint32_t* selected_columns, size_t selected_columns_len, row_filter filter) {
    return write_projected_batch(nullptr, 0, true, selected_columns, selected_columns_len, filter);
  }

  uint64_t write_count(const uint8_t* data, size_t len, bool final) {
    return write_count_where(data, len, final, row_filter{});
  }

  uint64_t write_count_where_equals(const uint8_t* data, size_t len, bool final, row_filter filter) {
    filter.kind = filter.enabled ? row_filter_kind::equals : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where_in(const uint8_t* data, size_t len, bool final, row_filter filter) {
    filter.kind = filter.enabled ? row_filter_kind::in : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where_starts_with(const uint8_t* data, size_t len, bool final, row_filter filter) {
    filter.kind = filter.enabled ? row_filter_kind::starts_with : row_filter_kind::none;
    return write_count_where(data, len, final, filter);
  }

  uint64_t write_count_where(const uint8_t* data, size_t len, bool final, row_filter filter) {
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

  uint64_t finish_count_where_equals(row_filter filter) { return write_count_where_equals(nullptr, 0, true, filter); }

  uint64_t finish_count_where_in(row_filter filter) { return write_count_where_in(nullptr, 0, true, filter); }

  uint64_t finish_count_where_starts_with(row_filter filter) {
    return write_count_where_starts_with(nullptr, 0, true, filter);
  }

  void reset() {
    field_.clear();
    row_fields_.clear();
    projected_fields_.clear();
    error_.clear();
    batch_ = nullptr;
    selected_columns_ = nullptr;
    selected_columns_len_ = 0;
    projection_enabled_ = false;
    fixed_columns_enabled_ = false;
    fixed_columns_ = 0;
    parse_failed_ = false;
    strict_expected_columns_ = 0;
    strict_expected_columns_seen_ = false;
    filter_ = row_filter{};
    in_filter_values_.clear();
    in_filter_set_.clear();
    use_in_filter_set_ = false;
    in_quotes_ = false;
    pending_quote_ = false;
    at_field_start_ = true;
    saw_row_data_ = false;
    previous_was_cr_ = false;
    current_column_ = 0;
    row_filter_seen_ = false;
    row_filter_matched_ = false;
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

  const char* last_error() const { return error_.empty() ? "" : error_.c_str(); }

  void set_error(const char* value) { error_ = value; }

private:
  csv_batch* write_batch_impl(const uint8_t* data, size_t len, bool final, bool strict) {
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

  void configure(const uint32_t* selected_columns, size_t selected_columns_len, row_filter filter) {
    selected_columns_ = selected_columns;
    selected_columns_len_ = selected_columns_len;
    projection_enabled_ = selected_columns != nullptr;
    filter_ = filter;
    prepare_in_filter(filter);
    selected_column_counts_.clear();
    selected_column_outputs_.clear();

    if (projection_enabled_ && projected_fields_.size() != selected_columns_len_) {
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
      selected_column_outputs_.assign(static_cast<size_t>(max_column) + 1, std::vector<uint32_t>{});
      for (size_t i = 0; i < selected_columns_len_; ++i) {
        const uint32_t column = selected_columns_[i];
        ++selected_column_counts_[column];
        selected_column_outputs_[column].push_back(checked_u32(i));
      }
    }
    direct_projection_ = can_use_direct_projection();
    restore_direct_projection_row();
  }

  void prepare_in_filter(const row_filter& filter) {
    constexpr size_t hash_filter_threshold = 8;
    if (!filter.enabled || filter.kind != row_filter_kind::in || filter.value_count < hash_filter_threshold) {
      use_in_filter_set_ = false;
      return;
    }

    bool unchanged = in_filter_values_.size() == filter.value_count;
    for (size_t index = 0; unchanged && index < filter.value_count; ++index) {
      const uint32_t start = filter.value_offsets[index];
      const uint32_t end = filter.value_offsets[index + 1];
      const size_t len = end - start;
      const auto& cached = in_filter_values_[index];
      unchanged =
          cached.size() == len && (len == 0 || std::memcmp(cached.data(), filter.values_data + start, len) == 0);
    }
    if (unchanged) {
      use_in_filter_set_ = true;
      return;
    }

    in_filter_values_.clear();
    in_filter_values_.reserve(filter.value_count);
    for (size_t index = 0; index < filter.value_count; ++index) {
      const uint32_t start = filter.value_offsets[index];
      const uint32_t end = filter.value_offsets[index + 1];
      if (end == start) {
        in_filter_values_.emplace_back();
      } else {
        in_filter_values_.emplace_back(reinterpret_cast<const char*>(filter.values_data + start), end - start);
      }
    }

    in_filter_set_.clear();
    in_filter_set_.reserve(filter.value_count);
    for (const auto& value : in_filter_values_) {
      in_filter_set_.insert(value);
    }
    use_in_filter_set_ = true;
  }

  void parse(const uint8_t* data, size_t len) {
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
          if (strict_quote_syntax_ && !is_quoted_field_terminator(data[i], delimiter_)) {
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
        const size_t close_quote = find_complete_quoted_field_close(data + i, len - i);
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
        fail_parse("strict CSV quote syntax error: unescaped quote in unquoted field");
        return;
      }

      const size_t span = find_plain_span(data + i, len - i);
      append_plain_span(data + i, span, len - i);
      i += span;
    }
  }

  void parse_count_only(const uint8_t* data, size_t len) {
    csv_structural_state state{
        .in_quotes = in_quotes_,
        .pending_quote = pending_quote_,
        .at_field_start = at_field_start_,
        .previous_was_cr = previous_was_cr_,
        .saw_row_data = saw_row_data_,
    };
    const auto on_row_end = [this](uint64_t) {
      ++emitted_rows_;
      current_column_ = 0;
      return true;
    };
    scan_csv_row_ends<false>(data, len, delimiter_, 0, state, on_row_end);
    in_quotes_ = state.in_quotes;
    pending_quote_ = state.pending_quote;
    at_field_start_ = state.at_field_start;
    previous_was_cr_ = state.previous_was_cr;
    saw_row_data_ = state.saw_row_data;
  }

  size_t find_plain_span(const uint8_t* data, size_t len) const {
    const size_t found = strict_quote_syntax_ ? find_strict_plain_special_simd(data, len, delimiter_)
                                              : find_plain_special_simd(data, len, delimiter_);
    return found == npos ? len : found;
  }

  HWY_ATTR size_t find_complete_quoted_field_close(const uint8_t* data, size_t len) const {
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

  void append_plain_span(const uint8_t* data, size_t len, size_t remaining) {
    if (can_append_complete_plain_field_to_arena(len, remaining)) {
      append_utf8_span_to_arena(data, len);
      return;
    }

    append_decoded_span(data, len);
  }

  void append_decoded_span(const uint8_t* data, size_t len) {
    if (len == 0) {
      return;
    }
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!should_capture_current_field()) {
      return;
    }

    if (encoding_ == csv_encoding::utf8) {
      field_.append(reinterpret_cast<const char*>(data), len);
      return;
    }

    append_latin1(field_, data, len);
  }

  bool can_append_complete_plain_field_to_arena(size_t len, size_t remaining) const {
    return mode_ == output_mode::batch && encoding_ == csv_encoding::utf8 && batch_ != nullptr &&
           (!use_deferred_rows() || can_append_direct_projection_to_arena()) && at_field_start_ && field_.empty() &&
           !field_in_arena_ && len < remaining;
  }

  bool can_append_direct_projection_to_arena() const {
    return direct_projection_ && should_store_current_field() &&
           (!filter_.enabled || current_column_ != filter_.column);
  }

  void append_utf8_span_to_arena(const uint8_t* data, size_t len) {
    saw_row_data_ = true;
    at_field_start_ = false;
    field_in_arena_ = true;
    ensure_direct_projection_row_started();
    if (len != 0) {
      batch_->data.append(reinterpret_cast<const char*>(data), len);
    }
  }

  void append_complete_quoted_field(const uint8_t* data, size_t close_quote) {
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!should_capture_current_field()) {
      return;
    }

    if (encoding_ == csv_encoding::utf8 && mode_ == output_mode::batch && batch_ != nullptr &&
        (!use_deferred_rows() || can_append_direct_projection_to_arena()) && field_.empty() && !field_in_arena_) {
      append_quoted_field_to_arena(data, close_quote);
      return;
    }

    append_quoted_field_to_field_buffer(data, close_quote);
  }

  void append_quoted_field_to_arena(const uint8_t* data, size_t close_quote) {
    field_in_arena_ = true;
    ensure_direct_projection_row_started();
    if (!complete_quoted_field_has_escape_) {
      batch_->data.append(reinterpret_cast<const char*>(data + 1), close_quote - 1);
      return;
    }

    size_t segment_start = 1;
    for (size_t i = 1; i < close_quote; ++i) {
      if (data[i] == '"' && i + 1 < close_quote && data[i + 1] == '"') {
        batch_->data.append(reinterpret_cast<const char*>(data + segment_start), i - segment_start);
        batch_->data.push_back('"');
        ++i;
        segment_start = i + 1;
      }
    }
    batch_->data.append(reinterpret_cast<const char*>(data + segment_start), close_quote - segment_start);
  }

  void append_quoted_field_to_field_buffer(const uint8_t* data, size_t close_quote) {
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
    } else if (mode_ == output_mode::batch && batch_ != nullptr) {
      if (!field_in_arena_) {
        batch_->data.append(field_);
      }
      batch_->field_offsets.push_back(batch_->data.size());
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
    const bool emit_row = !filter_.enabled || (row_filter_seen_ && row_filter_matched_);
    if (mode_ == output_mode::batch && emit_row) {
      if (direct_projection_) {
        finish_direct_projection_row();
      } else if (use_deferred_rows()) {
        commit_deferred_batch_row();
      } else {
        finish_batch_row();
      }
    } else if (mode_ == output_mode::batch && direct_projection_) {
      rollback_direct_projection_row();
    }
    if (emit_row) {
      ++emitted_rows_;
    }
    reset_row_state();
    saw_row_data_ = false;
    at_field_start_ = true;
  }

  bool use_deferred_rows() const {
    return projection_enabled_ || filter_.enabled || fixed_columns_enabled_ || deferred_batch_row_;
  }

  bool should_capture_current_field() const {
    if (mode_ == output_mode::count) {
      return filter_.enabled && current_column_ == filter_.column;
    }

    if (!use_deferred_rows()) {
      return true;
    }

    return should_store_current_field() || (filter_.enabled && current_column_ == filter_.column);
  }

  bool should_store_current_field() const { return !projection_enabled_ || selected_output_count(current_column_) > 0; }

  bool can_use_direct_projection() const {
    if (!allow_direct_projection_ || mode_ != output_mode::batch || !projection_enabled_ ||
        selected_columns_len_ == 0) {
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
    return column < selected_column_counts_.size() ? selected_column_counts_[column] : 0;
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

    for (const uint32_t output_index : selected_column_outputs_[current_column_]) {
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
    batch_->field_offsets.push_back(batch_->data.size());
  }

  void ensure_direct_projection_row_started() {
    if (!direct_projection_ || batch_ == nullptr || direct_projection_row_started_) {
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

  void finish_direct_projection_row() {
    ensure_direct_projection_row_started();
    const size_t field_count = batch_->field_offsets.size() - direct_projection_field_offsets_start_;
    for (size_t index = field_count; index < selected_columns_len_; ++index) {
      batch_->field_offsets.push_back(batch_->data.size());
    }
    finish_batch_row();
  }

  void restore_direct_projection_row() {
    if (!direct_projection_ || batch_ == nullptr || direct_projection_carry_count_ == 0) {
      return;
    }

    direct_projection_row_started_ = true;
    direct_projection_data_start_ = batch_->data.size();
    direct_projection_field_offsets_start_ = batch_->field_offsets.size();
    for (size_t index = 0; index < direct_projection_carry_count_; ++index) {
      batch_->data.append(projected_fields_[index]);
      batch_->field_offsets.push_back(batch_->data.size());
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

  bool field_equals_filter(const uint8_t* value, size_t value_len) const {
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
    if (use_in_filter_set_) {
      return in_filter_set_.find(field_) != in_filter_set_.end();
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

  void commit_fields(const std::vector<std::string>& fields) {
    if (batch_ == nullptr) {
      return;
    }

    for (const auto& field : fields) {
      batch_->data.append(field);
      batch_->field_offsets.push_back(batch_->data.size());
    }
    finish_batch_row();
  }

  void reset_row_state() {
    current_column_ = 0;
    row_filter_seen_ = false;
    row_filter_matched_ = false;
    row_fields_.clear();
    for (auto& field : projected_fields_) {
      field.clear();
    }
    deferred_batch_row_ = false;
    direct_projection_row_started_ = false;
    direct_projection_data_start_ = 0;
    direct_projection_field_offsets_start_ = 0;
    direct_projection_carry_count_ = 0;
  }

  void spill_unfinished_direct_projection_row() {
    if (batch_ == nullptr || !saw_row_data_ || !direct_projection_ || !direct_projection_row_started_) {
      return;
    }

    const size_t field_count = batch_->field_offsets.size() - direct_projection_field_offsets_start_;
    for (size_t index = direct_projection_carry_count_; index < field_count; ++index) {
      const size_t offset_index = direct_projection_field_offsets_start_ + index;
      const size_t start = batch_->field_offsets[offset_index - 1];
      const size_t end = batch_->field_offsets[offset_index];
      projected_fields_[index].assign(batch_->data.data() + start, end - start);
    }
    direct_projection_carry_count_ = field_count;
    rollback_direct_projection_row();
  }

  void spill_unfinished_batch_row() {
    if (batch_ == nullptr || !saw_row_data_ || projection_enabled_ || filter_.enabled || fixed_columns_enabled_ ||
        deferred_batch_row_) {
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
    for (size_t field_index = row_start; field_index < completed_field_count; ++field_index) {
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
      const uint64_t row_start = batch_->row_offsets.back();
      const size_t row_end = batch_->field_offsets.size() - 1;
      const size_t field_count = row_end - row_start;
      if (field_count != fixed_columns_) {
        set_error("fixed row column count mismatch");
        parse_failed_ = true;
        return;
      }
    }

    if (strict_quote_syntax_ && !fixed_columns_enabled_) {
      const uint64_t row_start = batch_->row_offsets.back();
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

    batch_->row_offsets.push_back(batch_->field_offsets.size() - 1);
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

  void fail_parse(const char* message) {
    set_error(message);
    parse_failed_ = true;
  }

  static uint32_t checked_u32(size_t value) {
    if (value > std::numeric_limits<uint32_t>::max()) {
      return std::numeric_limits<uint32_t>::max();
    }
    return static_cast<uint32_t>(value);
  }

  csv_encoding encoding_;
  uint8_t delimiter_;
  output_mode mode_ = output_mode::batch;
  csv_batch* batch_ = nullptr;
  const uint32_t* selected_columns_ = nullptr;
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
  std::vector<std::string> row_fields_;
  std::vector<std::string> projected_fields_;
  std::vector<std::string> in_filter_values_;
  ankerl::unordered_dense::set<std::string> in_filter_set_;
  bool use_in_filter_set_ = false;
  std::string error_;
  bool in_quotes_ = false;
  bool pending_quote_ = false;
  bool at_field_start_ = true;
  bool saw_row_data_ = false;
  bool previous_was_cr_ = false;
  uint32_t current_column_ = 0;
  bool row_filter_seen_ = false;
  bool row_filter_matched_ = false;
  bool field_in_arena_ = false;
  mutable bool complete_quoted_field_has_escape_ = false;
  bool allow_direct_projection_ = false;
  bool deferred_batch_row_ = false;
  uint64_t emitted_rows_ = 0;
};

csv_parser* checked_parser(void* parser) { return static_cast<csv_parser*>(parser); }

csv_batch* checked_batch(void* batch) { return static_cast<csv_batch*>(batch); }

csv_split_offsets_batch* checked_split_offsets_batch(void* batch) {
  return static_cast<csv_split_offsets_batch*>(batch);
}

bool valid_value_offsets(const uint32_t* offsets, size_t value_count, uint64_t values_data_len) {
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

bool valid_column_index(csv_parser& parser, uint32_t column) {
  if (column <= max_column_index) {
    return true;
  }
  parser.set_error("column index exceeds maximum of 2024");
  return false;
}

bool valid_projection(csv_parser& parser, const uint32_t* selected_columns, uint64_t selected_columns_len) {
  if (selected_columns_len > max_projection_length) {
    parser.set_error("selected columns length exceeds maximum of 2024");
    return false;
  }
  if (selected_columns == nullptr) {
    parser.set_error("selected columns are null");
    return false;
  }

  std::array<bool, max_column_index + 1> seen{};
  for (size_t index = 0; index < selected_columns_len; ++index) {
    const uint32_t column = selected_columns[index];
    if (!valid_column_index(parser, column)) {
      return false;
    }
    if (seen[column]) {
      parser.set_error("selected columns must not contain duplicates");
      return false;
    }
    seen[column] = true;
  }
  return true;
}

} // namespace csv_native

CSV_EXPORT void* csv_parser_create(int encoding, uint8_t delimiter) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }
  const auto selected = encoding == 1 ? csv_native::csv_encoding::latin1 : csv_native::csv_encoding::utf8;
  return new csv_native::csv_parser(selected, delimiter);
}

CSV_EXPORT void csv_parser_destroy(void* parser) { delete csv_native::checked_parser(parser); }

CSV_EXPORT void csv_parser_reset(void* parser) {
  if (parser == nullptr) {
    return;
  }
  csv_native::checked_parser(parser)->reset();
}

CSV_EXPORT void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_batch(data, static_cast<size_t>(len), final);
}

CSV_EXPORT void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_strict_batch(data, static_cast<size_t>(len), final);
}

CSV_EXPORT void* csv_parser_finish_batch(void* parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_batch();
}

CSV_EXPORT void* csv_parser_finish_strict_batch(void* parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_strict_batch();
}

CSV_EXPORT void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                              uint32_t fixed_columns) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_fixed_batch(data, static_cast<size_t>(len), final, fixed_columns);
}

CSV_EXPORT void* csv_parser_write_strict_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                     uint32_t fixed_columns) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->write_strict_fixed_batch(data, static_cast<size_t>(len), final,
                                                                      fixed_columns);
}

CSV_EXPORT void* csv_parser_finish_fixed_batch(void* parser, uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_fixed_batch(fixed_columns);
}

CSV_EXPORT void* csv_parser_finish_strict_fixed_batch(void* parser, uint32_t fixed_columns) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->finish_strict_fixed_batch(fixed_columns);
}

CSV_EXPORT void* csv_parser_write_projected_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                  bool has_projection, const uint32_t* selected_columns,
                                                  uint64_t selected_columns_len, bool has_filter,
                                                  uint32_t filter_column, const uint8_t* filter_value,
                                                  uint64_t filter_value_len) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return nullptr;
  }

  auto* typed = csv_native::checked_parser(parser);
  if ((has_projection && !csv_native::valid_projection(*typed, selected_columns, selected_columns_len)) ||
      (has_filter && !csv_native::valid_column_index(*typed, filter_column))) {
    return nullptr;
  }

  return typed->write_projected_batch(
      data, static_cast<size_t>(len), final, has_projection ? selected_columns : nullptr,
      has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::row_filter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::row_filter_kind::equals : csv_native::row_filter_kind::none,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT void* csv_parser_finish_projected_batch(void* parser, bool has_projection, const uint32_t* selected_columns,
                                                   uint64_t selected_columns_len, bool has_filter,
                                                   uint32_t filter_column, const uint8_t* filter_value,
                                                   uint64_t filter_value_len) {
  if (parser == nullptr || filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return nullptr;
  }

  auto* typed = csv_native::checked_parser(parser);
  if ((has_projection && !csv_native::valid_projection(*typed, selected_columns, selected_columns_len)) ||
      (has_filter && !csv_native::valid_column_index(*typed, filter_column))) {
    return nullptr;
  }

  return typed->finish_projected_batch(
      has_projection ? selected_columns : nullptr, has_projection ? static_cast<size_t>(selected_columns_len) : 0,
      csv_native::row_filter{
          .enabled = has_filter,
          .kind = has_filter ? csv_native::row_filter_kind::equals : csv_native::row_filter_kind::none,
          .column = filter_column,
          .value = filter_value,
          .value_len = static_cast<size_t>(filter_value_len),
      });
}

CSV_EXPORT void csv_batch_destroy(void* batch) { delete static_cast<csv_native::csv_batch*>(batch); }

CSV_EXPORT uint64_t csv_batch_row_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto* typed = static_cast<const csv_native::csv_batch*>(batch);
  return typed->row_offsets.empty() ? 0 : typed->row_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_total_fields(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto* typed = static_cast<const csv_native::csv_batch*>(batch);
  return typed->field_offsets.empty() ? 0 : typed->field_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_data_len(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return static_cast<const csv_native::csv_batch*>(batch)->data.size();
}

CSV_EXPORT const uint8_t* csv_batch_data_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto* typed = static_cast<const csv_native::csv_batch*>(batch);
  return reinterpret_cast<const uint8_t*>(typed->data.data());
}

CSV_EXPORT const uint64_t* csv_batch_row_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::csv_batch*>(batch)->row_offsets.data();
}

CSV_EXPORT const uint64_t* csv_batch_field_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::csv_batch*>(batch)->field_offsets.data();
}

CSV_EXPORT uint64_t csv_batch_count_where_equals(void* batch, uint32_t column, const uint8_t* value,
                                                 uint64_t value_len) {
  if (batch == nullptr || (value == nullptr && value_len != 0) ||
      value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }
  if (column > csv_native::max_column_index) {
    return 0;
  }

  const auto* typed = csv_native::checked_batch(batch);
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
    if (len == needle_len && std::memcmp(typed->data.data() + start, value, len) == 0) {
      ++count;
    }
  }

  return count;
}

CSV_EXPORT uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->write_count(data, static_cast<size_t>(len), final);
}

CSV_EXPORT uint64_t csv_parser_count_trusted_newlines(const uint8_t* data, uint64_t len) {
  if (len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::count_trusted_newlines(data, static_cast<size_t>(len));
}

CSV_EXPORT void* csv_parser_find_split_offsets(const char* path, uint64_t shard_count, uint8_t delimiter) {
  if (shard_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }
  auto batch = csv_native::find_csv_safe_split_offsets(path, static_cast<size_t>(shard_count), delimiter);
  return batch.release();
}

CSV_EXPORT void csv_split_offsets_batch_destroy(void* batch) { delete csv_native::checked_split_offsets_batch(batch); }

CSV_EXPORT uint64_t csv_split_offsets_batch_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_split_offsets_batch(batch)->offsets.size();
}

CSV_EXPORT const uint64_t* csv_split_offsets_batch_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_split_offsets_batch(batch)->offsets.data();
}

CSV_EXPORT uint64_t csv_parser_finish_count(void* parser) {
  if (parser == nullptr) {
    return 0;
  }

  return csv_native::checked_parser(parser)->finish_count();
}

CSV_EXPORT uint64_t csv_parser_write_count_where_equals(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                        uint32_t filter_column, const uint8_t* filter_value,
                                                        uint64_t filter_value_len) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->write_count_where_equals(data, static_cast<size_t>(len), final,
                                         csv_native::row_filter{
                                             .enabled = true,
                                             .kind = csv_native::row_filter_kind::equals,
                                             .column = filter_column,
                                             .value = filter_value,
                                             .value_len = static_cast<size_t>(filter_value_len),
                                         });
}

CSV_EXPORT uint64_t csv_parser_write_count_where_in(void* parser, const uint8_t* data, uint64_t len, bool final,
                                                    uint32_t filter_column, const uint8_t* values_data,
                                                    uint64_t values_data_len, const uint32_t* value_offsets,
                                                    uint64_t value_count) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      values_data_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      value_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (values_data == nullptr && values_data_len != 0) ||
      !csv_native::valid_value_offsets(value_offsets, static_cast<size_t>(value_count), values_data_len)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->write_count_where_in(data, static_cast<size_t>(len), final,
                                     csv_native::row_filter{
                                         .enabled = true,
                                         .kind = csv_native::row_filter_kind::in,
                                         .column = filter_column,
                                         .values_data = values_data,
                                         .value_offsets = value_offsets,
                                         .value_count = static_cast<size_t>(value_count),
                                     });
}

CSV_EXPORT uint64_t csv_parser_write_count_where_starts_with(void* parser, const uint8_t* data, uint64_t len,
                                                             bool final, uint32_t filter_column,
                                                             const uint8_t* filter_value, uint64_t filter_value_len) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->write_count_where_starts_with(data, static_cast<size_t>(len), final,
                                              csv_native::row_filter{
                                                  .enabled = true,
                                                  .kind = csv_native::row_filter_kind::starts_with,
                                                  .column = filter_column,
                                                  .value = filter_value,
                                                  .value_len = static_cast<size_t>(filter_value_len),
                                              });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_equals(void* parser, uint32_t filter_column,
                                                         const uint8_t* filter_value, uint64_t filter_value_len) {
  if (parser == nullptr || filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->finish_count_where_equals(csv_native::row_filter{
      .enabled = true,
      .kind = csv_native::row_filter_kind::equals,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
  });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_in(void* parser, uint32_t filter_column, const uint8_t* values_data,
                                                     uint64_t values_data_len, const uint32_t* value_offsets,
                                                     uint64_t value_count) {
  if (parser == nullptr || values_data_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      value_count > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (values_data == nullptr && values_data_len != 0) ||
      !csv_native::valid_value_offsets(value_offsets, static_cast<size_t>(value_count), values_data_len)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->finish_count_where_in(csv_native::row_filter{
      .enabled = true,
      .kind = csv_native::row_filter_kind::in,
      .column = filter_column,
      .values_data = values_data,
      .value_offsets = value_offsets,
      .value_count = static_cast<size_t>(value_count),
  });
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_starts_with(void* parser, uint32_t filter_column,
                                                              const uint8_t* filter_value, uint64_t filter_value_len) {
  if (parser == nullptr || filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
      (filter_value == nullptr && filter_value_len != 0)) {
    return 0;
  }

  auto* typed = csv_native::checked_parser(parser);
  if (!csv_native::valid_column_index(*typed, filter_column)) {
    return 0;
  }

  return typed->finish_count_where_starts_with(csv_native::row_filter{
      .enabled = true,
      .kind = csv_native::row_filter_kind::starts_with,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
  });
}

CSV_EXPORT const char* csv_parser_last_error(void* parser) {
  if (parser == nullptr) {
    return "parser is null";
  }
  return csv_native::checked_parser(parser)->last_error();
}
