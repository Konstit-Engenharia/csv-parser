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
};

struct EqualsFilter {
  bool enabled = false;
  uint32_t column = 0;
  const uint8_t* value = nullptr;
  size_t value_len = 0;
};

struct CsvBatch {
  std::vector<uint32_t> row_offsets{0};
  std::vector<uint32_t> field_offsets{0};
  std::string data;

  void Reserve(size_t input_len, Encoding encoding) {
    const size_t data_capacity = encoding == Encoding::kLatin1 ? input_len * 2 : input_len;
    data.reserve(data_capacity);
    field_offsets.reserve((input_len / 6) + 32);
    row_offsets.reserve((input_len / 160) + 32);
  }
};

struct CsvDictionaryBatch {
  std::vector<uint32_t> ids;
  std::vector<uint32_t> dict_offsets{0};
  std::string dict_data;

  uint64_t row_count() const {
    return ids.size();
  }

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

constexpr size_t kNpos = std::numeric_limits<size_t>::max();

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

void append_latin1(std::string& out, const uint8_t* data, size_t len) {
  const hn::ScalableTag<uint8_t> du8;
  const size_t lanes = hn::Lanes(du8);
  const auto limit = hn::Set(du8, static_cast<uint8_t>(0x80));
  size_t i = 0;

  while (i + lanes <= len) {
    const auto bytes = hn::LoadU(du8, data + i);
    if (!hn::AllTrue(du8, hn::Lt(bytes, limit))) {
      break;
    }
    out.append(reinterpret_cast<const char*>(data + i), lanes);
    i += lanes;
  }

  append_latin1_scalar(out, data + i, len - i);
}

size_t find_byte_simd(const uint8_t* data, size_t len, uint8_t needle) {
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

size_t find_plain_special_simd(const uint8_t* data, size_t len, uint8_t delimiter) {
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
  return kNpos;
}

class CsvParser {
 public:
  CsvParser(Encoding encoding, uint8_t delimiter) : encoding_(encoding), delimiter_(delimiter) {}

  CsvBatch* WriteBatch(const uint8_t* data, size_t len, bool final) {
    return WriteProjectedBatch(data, len, final, nullptr, 0, EqualsFilter{});
  }

  CsvBatch* WriteProjectedBatch(const uint8_t* data, size_t len, bool final, const uint32_t* selected_columns, size_t selected_columns_len, EqualsFilter filter) {
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

  CsvBatch* FinishBatch() {
    return WriteBatch(nullptr, 0, true);
  }

  CsvBatch* FinishProjectedBatch(const uint32_t* selected_columns, size_t selected_columns_len, EqualsFilter filter) {
    return WriteProjectedBatch(nullptr, 0, true, selected_columns, selected_columns_len, filter);
  }

  CsvDictionaryBatch* WriteDictionaryBatch(const uint8_t* data, size_t len, bool final, uint32_t column) {
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

  CsvDictionaryBatch* FinishDictionaryBatch(uint32_t column) {
    return WriteDictionaryBatch(nullptr, 0, true, column);
  }

  uint64_t WriteGroupByCount(const uint8_t* data, size_t len, uint32_t column) {
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

  CsvGroupByCountBatch* FinishGroupByCount(uint32_t column) {
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

  uint64_t WriteCount(const uint8_t* data, size_t len, bool final) {
    return WriteCountWhereEquals(data, len, final, EqualsFilter{});
  }

  uint64_t WriteCountWhereEquals(const uint8_t* data, size_t len, bool final, EqualsFilter filter) {
    mode_ = OutputMode::kCount;
    Configure(nullptr, 0, filter);
    emitted_rows_ = 0;
    Parse(data, len);
    if (final) {
      FinishStream();
    }
    return emitted_rows_;
  }

  uint64_t FinishCount() {
    return WriteCount(nullptr, 0, true);
  }

  uint64_t FinishCountWhereEquals(EqualsFilter filter) {
    return WriteCountWhereEquals(nullptr, 0, true, filter);
  }

  void Reset() {
    field_.clear();
    row_fields_.clear();
    projected_fields_.clear();
    error_.clear();
    batch_ = nullptr;
    dictionary_batch_ = nullptr;
    group_by_count_batch_ = nullptr;
    group_by_count_batch_owner_.reset();
    dictionary_hash_ids_.clear();
    dictionary_hash_collisions_.clear();
    group_by_hash_ids_.clear();
    group_by_hash_collisions_.clear();
    selected_columns_ = nullptr;
    selected_columns_len_ = 0;
    projection_enabled_ = false;
    filter_ = EqualsFilter{};
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
    emitted_rows_ = 0;
    field_in_arena_ = false;
  }

  const char* LastError() const {
    return error_.empty() ? "" : error_.c_str();
  }

  void SetError(const char* value) {
    error_ = value;
  }

 private:
  void Configure(const uint32_t* selected_columns, size_t selected_columns_len, EqualsFilter filter) {
    selected_columns_ = selected_columns;
    selected_columns_len_ = selected_columns_len;
    projection_enabled_ = selected_columns != nullptr;
    filter_ = filter;

    if (projection_enabled_ && projected_fields_.size() != selected_columns_len_) {
      projected_fields_.assign(selected_columns_len_, std::string{});
    }
  }

  void Parse(const uint8_t* data, size_t len) {
    if (data == nullptr || len == 0) {
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
        const size_t close_quote = FindCompleteQuotedFieldClose(data + i, len - i);
        if (close_quote != kNpos) {
          AppendCompleteQuotedField(data + i, close_quote);
          i += close_quote + 1;
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

  size_t FindPlainSpan(const uint8_t* data, size_t len) const {
    const size_t found = find_plain_special_simd(data, len, delimiter_);
    return found == kNpos ? len : found;
  }

  size_t FindCompleteQuotedFieldClose(const uint8_t* data, size_t len) const {
    size_t i = 1;
    while (i < len) {
      const size_t quote = find_byte_simd(data + i, len - i, '"');
      if (quote == kNpos) {
        return kNpos;
      }

      i += quote;
      if (i + 1 >= len) {
        return kNpos;
      }

      const uint8_t next = data[i + 1];
      if (next == '"') {
        i += 2;
        continue;
      }
      if (next == delimiter_ || next == '\n' || next == '\r') {
        return i;
      }
      return kNpos;
    }

    return kNpos;
  }

  void AppendDecodedByte(uint8_t byte) {
    AppendDecodedSpan(&byte, 1);
  }

  void AppendPlainSpan(const uint8_t* data, size_t len, size_t remaining) {
    if (CanAppendCompletePlainFieldToArena(len, remaining)) {
      AppendUtf8SpanToArena(data, len);
      return;
    }

    AppendDecodedSpan(data, len);
  }

  void AppendDecodedSpan(const uint8_t* data, size_t len) {
    if (len == 0) {
      return;
    }
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!ShouldCaptureCurrentField()) {
      return;
    }

    if (encoding_ == Encoding::kUtf8) {
      field_.append(reinterpret_cast<const char*>(data), len);
      return;
    }

    append_latin1(field_, data, len);
  }

  bool CanAppendCompletePlainFieldToArena(size_t len, size_t remaining) const {
    return mode_ == OutputMode::kBatch && encoding_ == Encoding::kUtf8 && batch_ != nullptr && !UseDeferredRows() &&
           at_field_start_ && field_.empty() && !field_in_arena_ && len < remaining;
  }

  void AppendUtf8SpanToArena(const uint8_t* data, size_t len) {
    saw_row_data_ = true;
    at_field_start_ = false;
    field_in_arena_ = true;
    if (len != 0) {
      batch_->data.append(reinterpret_cast<const char*>(data), len);
    }
  }

  void AppendCompleteQuotedField(const uint8_t* data, size_t close_quote) {
    saw_row_data_ = true;
    at_field_start_ = false;

    if (!ShouldCaptureCurrentField()) {
      return;
    }

    if (encoding_ == Encoding::kUtf8 && mode_ == OutputMode::kBatch && batch_ != nullptr && !UseDeferredRows() && field_.empty() && !field_in_arena_) {
      AppendQuotedFieldToArena(data, close_quote);
      return;
    }

    AppendQuotedFieldToFieldBuffer(data, close_quote);
  }

  void AppendQuotedFieldToArena(const uint8_t* data, size_t close_quote) {
    field_in_arena_ = true;
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

  void AppendQuotedFieldToFieldBuffer(const uint8_t* data, size_t close_quote) {
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
    const bool emit_row = !filter_.enabled || (row_filter_seen_ && row_filter_matched_);
    if (mode_ == OutputMode::kBatch && emit_row) {
      if (UseDeferredRows()) {
        CommitDeferredBatchRow();
      } else {
        FinishBatchRow();
      }
    }
    if (mode_ == OutputMode::kDictionary) {
      FinishDictionaryRow();
    }
    if (mode_ == OutputMode::kGroupByCount) {
      FinishGroupByCountRow();
    }
    if (emit_row) {
      ++emitted_rows_;
    }
    ResetRowState();
    saw_row_data_ = false;
    at_field_start_ = true;
  }

  bool UseDeferredRows() const {
    return projection_enabled_ || filter_.enabled;
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

    if (!UseDeferredRows()) {
      return true;
    }

    return ShouldStoreCurrentField() || (filter_.enabled && current_column_ == filter_.column);
  }

  bool ShouldStoreCurrentField() const {
    return !projection_enabled_ || selected_output_count(current_column_) > 0;
  }

  size_t selected_output_count(uint32_t column) const {
    size_t count = 0;
    for (size_t i = 0; i < selected_columns_len_; ++i) {
      if (selected_columns_[i] == column) {
        ++count;
      }
    }
    return count;
  }

  void FinishDeferredField() {
    if (filter_.enabled && current_column_ == filter_.column) {
      row_filter_seen_ = true;
      row_filter_matched_ = FieldEqualsFilter();
    }

    if (mode_ != OutputMode::kBatch) {
      return;
    }

    if (!projection_enabled_) {
      row_fields_.push_back(field_);
      return;
    }

    for (size_t i = 0; i < selected_columns_len_; ++i) {
      if (selected_columns_[i] == current_column_) {
        projected_fields_[i] = field_;
      }
    }
  }

  bool FieldEqualsFilter() const {
    if (field_.size() != filter_.value_len) {
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
        *dictionary_batch_,
        dictionary_hash_ids_,
        dictionary_hash_collisions_,
        field_.data(),
        field_.size()
      );
    }
  }

  void FinishDictionaryRow() {
    if (dictionary_batch_ == nullptr) {
      return;
    }
    if (!dictionary_row_seen_) {
      dictionary_row_id_ = InternDictionaryValue(
        *dictionary_batch_,
        dictionary_hash_ids_,
        dictionary_hash_collisions_,
        nullptr,
        0
      );
    }
    dictionary_batch_->ids.push_back(dictionary_row_id_);
  }

  void FinishGroupByCountField() {
    if (group_by_count_batch_ != nullptr && current_column_ == group_by_column_) {
      group_by_row_seen_ = true;
      group_by_row_id_ = InternGroupByCountValue(
        *group_by_count_batch_,
        group_by_hash_ids_,
        group_by_hash_collisions_,
        field_.data(),
        field_.size()
      );
    }
  }

  void FinishGroupByCountRow() {
    if (group_by_count_batch_ == nullptr) {
      return;
    }
    if (!group_by_row_seen_) {
      group_by_row_id_ = InternGroupByCountValue(
        *group_by_count_batch_,
        group_by_hash_ids_,
        group_by_hash_collisions_,
        nullptr,
        0
      );
    }
    ++group_by_count_batch_->counts[group_by_row_id_];
    ++group_by_count_batch_->row_count;
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

  void CommitFields(const std::vector<std::string>& fields) {
    if (batch_ == nullptr) {
      return;
    }

    for (const auto& field : fields) {
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
    row_fields_.clear();
    for (auto& field : projected_fields_) {
      field.clear();
    }
  }

  void FinishBatchRow() {
    if (batch_ == nullptr) {
      return;
    }

    batch_->row_offsets.push_back(checked_u32(batch_->field_offsets.size() - 1));
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
    CsvDictionaryBatch& dictionary,
    std::unordered_map<uint64_t, uint32_t>& hash_ids,
    std::unordered_map<uint64_t, std::vector<uint32_t>>& hash_collisions,
    const char* value,
    size_t value_len
  ) {
    const char* actual = value == nullptr ? "" : value;
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

  static uint32_t AppendDictionaryValue(CsvDictionaryBatch& dictionary, const char* value, size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    return id;
  }

  static bool DictionaryValueEquals(const CsvDictionaryBatch& dictionary, uint32_t id, const char* value, size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return BytesEqual(dictionary.dict_data.data() + start, end - start, value, value_len);
  }

  static uint32_t InternGroupByCountValue(
    CsvGroupByCountBatch& dictionary,
    std::unordered_map<uint64_t, uint32_t>& hash_ids,
    std::unordered_map<uint64_t, std::vector<uint32_t>>& hash_collisions,
    const char* value,
    size_t value_len
  ) {
    const char* actual = value == nullptr ? "" : value;
    const uint64_t hash = HashBytes(actual, value_len);
    const auto found = hash_ids.find(hash);
    if (found != hash_ids.end()) {
      if (GroupByCountValueEquals(dictionary, found->second, actual, value_len)) {
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

      const uint32_t id = AppendGroupByCountValue(dictionary, actual, value_len);
      hash_collisions[hash].push_back(id);
      return id;
    }

    const uint32_t id = AppendGroupByCountValue(dictionary, actual, value_len);
    hash_ids.emplace(hash, id);
    return id;
  }

  static uint32_t AppendGroupByCountValue(CsvGroupByCountBatch& dictionary, const char* value, size_t value_len) {
    const uint32_t id = checked_u32(dictionary.dict_offsets.size() - 1);
    dictionary.dict_data.append(value, value_len);
    dictionary.dict_offsets.push_back(checked_u32(dictionary.dict_data.size()));
    dictionary.counts.push_back(0);
    return id;
  }

  static bool GroupByCountValueEquals(const CsvGroupByCountBatch& dictionary, uint32_t id, const char* value, size_t value_len) {
    const size_t start = dictionary.dict_offsets[id];
    const size_t end = dictionary.dict_offsets[id + 1];
    return BytesEqual(dictionary.dict_data.data() + start, end - start, value, value_len);
  }

  static uint64_t HashBytes(const char* data, size_t len) {
    uint64_t hash = 1469598103934665603ull;
    for (size_t index = 0; index < len; ++index) {
      hash ^= static_cast<uint8_t>(data[index]);
      hash *= 1099511628211ull;
    }
    return hash;
  }

  static bool BytesEqual(const char* left, size_t left_len, const char* right, size_t right_len) {
    return left_len == right_len && (left_len == 0 || std::memcmp(left, right, left_len) == 0);
  }

  Encoding encoding_;
  uint8_t delimiter_;
  OutputMode mode_ = OutputMode::kBatch;
  CsvBatch* batch_ = nullptr;
  CsvDictionaryBatch* dictionary_batch_ = nullptr;
  CsvGroupByCountBatch* group_by_count_batch_ = nullptr;
  std::unique_ptr<CsvGroupByCountBatch> group_by_count_batch_owner_;
  const uint32_t* selected_columns_ = nullptr;
  size_t selected_columns_len_ = 0;
  bool projection_enabled_ = false;
  EqualsFilter filter_;
  std::string field_;
  std::vector<std::string> row_fields_;
  std::vector<std::string> projected_fields_;
  std::unordered_map<uint64_t, uint32_t> dictionary_hash_ids_;
  std::unordered_map<uint64_t, std::vector<uint32_t>> dictionary_hash_collisions_;
  std::unordered_map<uint64_t, uint32_t> group_by_hash_ids_;
  std::unordered_map<uint64_t, std::vector<uint32_t>> group_by_hash_collisions_;
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
  bool field_in_arena_ = false;
  uint64_t emitted_rows_ = 0;
};

CsvParser* checked_parser(void* parser) {
  return static_cast<CsvParser*>(parser);
}

CsvBatch* checked_batch(void* batch) {
  return static_cast<CsvBatch*>(batch);
}

CsvDictionaryBatch* checked_dictionary_batch(void* batch) {
  return static_cast<CsvDictionaryBatch*>(batch);
}

CsvGroupByCountBatch* checked_group_by_count_batch(void* batch) {
  return static_cast<CsvGroupByCountBatch*>(batch);
}

}  // namespace csv_native

CSV_EXPORT void* csv_parser_create(int encoding, uint8_t delimiter) {
  if (delimiter == 0 || delimiter == '\n' || delimiter == '\r' || delimiter == '"') {
    return nullptr;
  }
  const auto selected = encoding == 1 ? csv_native::Encoding::kLatin1 : csv_native::Encoding::kUtf8;
  return new csv_native::CsvParser(selected, delimiter);
}

CSV_EXPORT void csv_parser_destroy(void* parser) {
  delete csv_native::checked_parser(parser);
}

CSV_EXPORT void csv_parser_reset(void* parser) {
  if (parser == nullptr) {
    return;
  }
  csv_native::checked_parser(parser)->Reset();
}

CSV_EXPORT void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->WriteBatch(data, static_cast<size_t>(len), final);
}

CSV_EXPORT void* csv_parser_finish_batch(void* parser) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishBatch();
}

CSV_EXPORT void* csv_parser_write_projected_batch(
  void* parser,
  const uint8_t* data,
  uint64_t len,
  bool final,
  bool has_projection,
  const uint32_t* selected_columns,
  uint64_t selected_columns_len,
  bool has_filter,
  uint32_t filter_column,
  const uint8_t* filter_value,
  uint64_t filter_value_len
) {
  if (
    parser == nullptr ||
    len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    selected_columns_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    (has_projection && selected_columns == nullptr) ||
    (filter_value == nullptr && filter_value_len != 0)
  ) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->WriteProjectedBatch(
    data,
    static_cast<size_t>(len),
    final,
    has_projection ? selected_columns : nullptr,
    has_projection ? static_cast<size_t>(selected_columns_len) : 0,
    csv_native::EqualsFilter{
      .enabled = has_filter,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
    }
  );
}

CSV_EXPORT void* csv_parser_finish_projected_batch(
  void* parser,
  bool has_projection,
  const uint32_t* selected_columns,
  uint64_t selected_columns_len,
  bool has_filter,
  uint32_t filter_column,
  const uint8_t* filter_value,
  uint64_t filter_value_len
) {
  if (
    parser == nullptr ||
    selected_columns_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    (has_projection && selected_columns == nullptr) ||
    (filter_value == nullptr && filter_value_len != 0)
  ) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishProjectedBatch(
    has_projection ? selected_columns : nullptr,
    has_projection ? static_cast<size_t>(selected_columns_len) : 0,
    csv_native::EqualsFilter{
      .enabled = has_filter,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
    }
  );
}

CSV_EXPORT void* csv_parser_write_dictionary_batch(
  void* parser,
  const uint8_t* data,
  uint64_t len,
  bool final,
  uint32_t column
) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->WriteDictionaryBatch(
    data,
    static_cast<size_t>(len),
    final,
    column
  );
}

CSV_EXPORT void* csv_parser_finish_dictionary_batch(void* parser, uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishDictionaryBatch(column);
}

CSV_EXPORT uint64_t csv_parser_write_group_by_count(
  void* parser,
  const uint8_t* data,
  uint64_t len,
  uint32_t column
) {
  if (parser == nullptr || len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
    return 0;
  }

  return csv_native::checked_parser(parser)->WriteGroupByCount(
    data,
    static_cast<size_t>(len),
    column
  );
}

CSV_EXPORT void* csv_parser_finish_group_by_count(void* parser, uint32_t column) {
  if (parser == nullptr) {
    return nullptr;
  }

  return csv_native::checked_parser(parser)->FinishGroupByCount(column);
}

CSV_EXPORT void csv_batch_destroy(void* batch) {
  delete static_cast<csv_native::CsvBatch*>(batch);
}

CSV_EXPORT void csv_dictionary_batch_destroy(void* batch) {
  delete static_cast<csv_native::CsvDictionaryBatch*>(batch);
}

CSV_EXPORT void csv_group_by_count_batch_destroy(void* batch) {
  delete static_cast<csv_native::CsvGroupByCountBatch*>(batch);
}

CSV_EXPORT uint64_t csv_dictionary_batch_row_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_dictionary_batch(batch)->row_count();
}

CSV_EXPORT uint64_t csv_dictionary_batch_dict_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_dictionary_batch(batch)->dict_count();
}

CSV_EXPORT const uint32_t* csv_dictionary_batch_ids_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_dictionary_batch(batch)->ids.data();
}

CSV_EXPORT const uint32_t* csv_dictionary_batch_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_dictionary_batch(batch)->dict_offsets.data();
}

CSV_EXPORT uint64_t csv_dictionary_batch_data_len(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_dictionary_batch(batch)->dict_data.size();
}

CSV_EXPORT const uint8_t* csv_dictionary_batch_data_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto* typed = csv_native::checked_dictionary_batch(batch);
  return reinterpret_cast<const uint8_t*>(typed->dict_data.data());
}

CSV_EXPORT uint64_t csv_group_by_count_batch_row_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_group_by_count_batch(batch)->row_count;
}

CSV_EXPORT uint64_t csv_group_by_count_batch_dict_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_group_by_count_batch(batch)->dict_count();
}

CSV_EXPORT const uint64_t* csv_group_by_count_batch_counts_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_group_by_count_batch(batch)->counts.data();
}

CSV_EXPORT const uint32_t* csv_group_by_count_batch_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return csv_native::checked_group_by_count_batch(batch)->dict_offsets.data();
}

CSV_EXPORT uint64_t csv_group_by_count_batch_data_len(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return csv_native::checked_group_by_count_batch(batch)->dict_data.size();
}

CSV_EXPORT const uint8_t* csv_group_by_count_batch_data_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto* typed = csv_native::checked_group_by_count_batch(batch);
  return reinterpret_cast<const uint8_t*>(typed->dict_data.data());
}

CSV_EXPORT uint64_t csv_batch_row_count(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto* typed = static_cast<const csv_native::CsvBatch*>(batch);
  return typed->row_offsets.empty() ? 0 : typed->row_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_total_fields(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  const auto* typed = static_cast<const csv_native::CsvBatch*>(batch);
  return typed->field_offsets.empty() ? 0 : typed->field_offsets.size() - 1;
}

CSV_EXPORT uint64_t csv_batch_data_len(void* batch) {
  if (batch == nullptr) {
    return 0;
  }
  return static_cast<const csv_native::CsvBatch*>(batch)->data.size();
}

CSV_EXPORT const uint8_t* csv_batch_data_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  const auto* typed = static_cast<const csv_native::CsvBatch*>(batch);
  return reinterpret_cast<const uint8_t*>(typed->data.data());
}

CSV_EXPORT const uint32_t* csv_batch_row_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::CsvBatch*>(batch)->row_offsets.data();
}

CSV_EXPORT const uint32_t* csv_batch_field_offsets_ptr(void* batch) {
  if (batch == nullptr) {
    return nullptr;
  }
  return static_cast<const csv_native::CsvBatch*>(batch)->field_offsets.data();
}

CSV_EXPORT uint64_t csv_batch_count_where_equals(void* batch, uint32_t column, const uint8_t* value, uint64_t value_len) {
  if (batch == nullptr || (value == nullptr && value_len != 0) || value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max())) {
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

  return csv_native::checked_parser(parser)->WriteCount(data, static_cast<size_t>(len), final);
}

CSV_EXPORT uint64_t csv_parser_finish_count(void* parser) {
  if (parser == nullptr) {
    return 0;
  }

  return csv_native::checked_parser(parser)->FinishCount();
}

CSV_EXPORT uint64_t csv_parser_write_count_where_equals(
  void* parser,
  const uint8_t* data,
  uint64_t len,
  bool final,
  uint32_t filter_column,
  const uint8_t* filter_value,
  uint64_t filter_value_len
) {
  if (
    parser == nullptr ||
    len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    (filter_value == nullptr && filter_value_len != 0)
  ) {
    return 0;
  }

  return csv_native::checked_parser(parser)->WriteCountWhereEquals(
    data,
    static_cast<size_t>(len),
    final,
    csv_native::EqualsFilter{
      .enabled = true,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
    }
  );
}

CSV_EXPORT uint64_t csv_parser_finish_count_where_equals(
  void* parser,
  uint32_t filter_column,
  const uint8_t* filter_value,
  uint64_t filter_value_len
) {
  if (
    parser == nullptr ||
    filter_value_len > static_cast<uint64_t>(std::numeric_limits<size_t>::max()) ||
    (filter_value == nullptr && filter_value_len != 0)
  ) {
    return 0;
  }

  return csv_native::checked_parser(parser)->FinishCountWhereEquals(
    csv_native::EqualsFilter{
      .enabled = true,
      .column = filter_column,
      .value = filter_value,
      .value_len = static_cast<size_t>(filter_value_len),
    }
  );
}

CSV_EXPORT const char* csv_parser_last_error(void* parser) {
  if (parser == nullptr) {
    return "parser is null";
  }
  return csv_native::checked_parser(parser)->LastError();
}
