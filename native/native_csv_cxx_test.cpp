#include <catch2/catch_test_macros.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

extern "C" {
void* csv_parser_create(int encoding, uint8_t delimiter);
void csv_parser_destroy(void* parser);
void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_finish_batch(void* parser);
void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_finish_strict_batch(void* parser);
void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final, uint32_t fixed_columns);
void* csv_parser_finish_fixed_batch(void* parser, uint32_t fixed_columns);
void* csv_parser_write_projected_batch(void* parser, const uint8_t* data, uint64_t len, bool final, bool has_projection,
                                       const uint32_t* selected_columns, uint64_t selected_columns_len, bool has_filter,
                                       uint32_t filter_column, const uint8_t* filter_value, uint64_t filter_value_len);
void* csv_parser_find_split_offsets(const char* path, uint64_t shard_count, uint8_t delimiter);
uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final);
uint64_t csv_parser_finish_count(void* parser);
uint64_t csv_parser_write_count_where_equals(void* parser, const uint8_t* data, uint64_t len, bool final,
                                             uint32_t filter_column, const uint8_t* filter_value,
                                             uint64_t filter_value_len);
const char* csv_parser_last_error(void* parser);
void csv_batch_destroy(void* batch);
void csv_split_offsets_batch_destroy(void* batch);
uint64_t csv_batch_row_count(void* batch);
uint64_t csv_batch_total_fields(void* batch);
uint64_t csv_batch_data_len(void* batch);
const uint8_t* csv_batch_data_ptr(void* batch);
const uint64_t* csv_batch_row_offsets_ptr(void* batch);
const uint64_t* csv_batch_field_offsets_ptr(void* batch);
uint64_t csv_split_offsets_batch_count(void* batch);
const uint64_t* csv_split_offsets_batch_ptr(void* batch);
}

static_assert(std::is_same_v<decltype(csv_batch_row_offsets_ptr(nullptr)), const uint64_t*>);
static_assert(std::is_same_v<decltype(csv_batch_field_offsets_ptr(nullptr)), const uint64_t*>);

namespace {

uint32_t next_random(uint32_t& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

void write_count_chunk(void* parser, std::string_view chunk, uint64_t& rows) {
  rows += csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(chunk.data()), chunk.size(), false);
}

std::string decode_latin1_reference(const uint8_t* data, size_t len) {
  std::string decoded;
  decoded.reserve(len * 2);
  for (size_t index = 0; index < len; ++index) {
    const uint8_t byte = data[index];
    if (byte < 0x80) {
      decoded.push_back(static_cast<char>(byte));
    } else {
      decoded.push_back(static_cast<char>(0xC0 | (byte >> 6)));
      decoded.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
    }
  }
  return decoded;
}

std::string make_fuzz_bytes(uint32_t seed) {
  static constexpr uint8_t alphabet[] = {
      'a', 'b', 'c', '0', '1', ',', ';', '"', '\n', '\r', ' ', 0x80, 0xE1,
  };
  uint32_t state = seed;
  const size_t len = 1 + (next_random(state) % 256);
  std::string bytes;
  bytes.reserve(len);
  for (size_t i = 0; i < len; ++i) {
    bytes.push_back(static_cast<char>(alphabet[next_random(state) % std::size(alphabet)]));
  }
  return bytes;
}

void destroy_batch_if_present(void* batch) {
  if (batch != nullptr) {
    csv_batch_destroy(batch);
  }
}

void fuzz_batch_mode(std::string_view input, bool strict) {
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);

  const size_t split = input.size() / 2;
  void* first =
      strict ? csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), split, false)
             : csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), split, false);
  destroy_batch_if_present(first);
  if (first == nullptr && strict) {
    csv_parser_destroy(parser);
    return;
  }

  void* second = strict ? csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(input.data() + split),
                                                        input.size() - split, false)
                        : csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data() + split),
                                                 input.size() - split, false);
  destroy_batch_if_present(second);
  if (second == nullptr && strict) {
    csv_parser_destroy(parser);
    return;
  }

  void* end = strict ? csv_parser_finish_strict_batch(parser) : csv_parser_finish_batch(parser);
  destroy_batch_if_present(end);
  csv_parser_destroy(parser);
}

void fuzz_fixed_mode(std::string_view input) {
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch =
      csv_parser_write_fixed_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true, 3);
  destroy_batch_if_present(batch);
  csv_parser_destroy(parser);
}

void fuzz_count_mode(std::string_view input) {
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  const size_t split = input.size() / 3;
  uint64_t rows = csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(input.data()), split, false);
  rows += csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(input.data() + split), input.size() - split,
                                 false);
  rows += csv_parser_finish_count(parser);
  csv_parser_destroy(parser);

  parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true);
  csv_parser_destroy(parser);
  REQUIRE(batch != nullptr);
  REQUIRE(rows == csv_batch_row_count(batch));
  csv_batch_destroy(batch);
}

} // namespace

TEST_CASE("native C ABI counts chunked quoted rows") {
  void* parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);

  uint64_t rows = 0;
  write_count_chunk(parser, "\"id\";\"uf\"\n\"1\";\"SP\"\n\"2\";\"", rows);
  write_count_chunk(parser, "RJ\"\n\"3\";\"S\nP\"", rows);
  rows += csv_parser_finish_count(parser);

  csv_parser_destroy(parser);

  REQUIRE(rows == 4);
}

TEST_CASE("native C ABI finds csv-safe split offsets") {
  const std::string path = "/tmp/csv-native-split-offsets.csv";
  {
    std::FILE* file = std::fopen(path.c_str(), "wb");
    REQUIRE(file != nullptr);
    static constexpr char content[] = "id;name;notes\n"
                                      "1;ana;\"um;dois\"\n"
                                      "2;bob;\"linha\ninterna\"\n"
                                      "3;cai;ok\n"
                                      "4;dio;fim\n";
    const size_t written = std::fwrite(content, 1, sizeof(content) - 1, file);
    REQUIRE(written == sizeof(content) - 1);
    REQUIRE(std::fclose(file) == 0);
  }

  void* batch = csv_parser_find_split_offsets(path.c_str(), 3, ';');
  REQUIRE(batch != nullptr);

  const uint64_t count = csv_split_offsets_batch_count(batch);
  REQUIRE(count >= 2);
  const uint64_t* offsets = csv_split_offsets_batch_ptr(batch);
  REQUIRE(offsets != nullptr);
  REQUIRE(offsets[0] == 0);

  std::string bytes;
  {
    std::FILE* file = std::fopen(path.c_str(), "rb");
    REQUIRE(file != nullptr);
    REQUIRE(std::fseek(file, 0, SEEK_END) == 0);
    const int64_t end = std::ftell(file);
    REQUIRE(end >= 0);
    REQUIRE(std::fseek(file, 0, SEEK_SET) == 0);
    bytes.resize(static_cast<size_t>(end));
    const size_t read = std::fread(bytes.data(), 1, bytes.size(), file);
    REQUIRE(read == bytes.size());
    REQUIRE(std::fclose(file) == 0);
  }

  for (uint64_t index = 1; index < count; ++index) {
    REQUIRE(offsets[index] >= offsets[index - 1]);
    if (offsets[index] == static_cast<uint64_t>(bytes.size())) {
      continue;
    }
    REQUIRE(offsets[index] < bytes.size());
    REQUIRE(bytes[static_cast<size_t>(offsets[index] - 1)] == '\n');
  }

  REQUIRE(offsets[count - 1] == bytes.size());
  csv_split_offsets_batch_destroy(batch);
  REQUIRE(std::remove(path.c_str()) == 0);
}

TEST_CASE("native C ABI decodes latin1 batches to utf8") {
  const uint8_t input[] = {
      'n', 'a', 'm', 'e', '\n', 'J', 'o', 0xE3, 'o', '\n',
  };

  void* parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, input, sizeof(input), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 2);
  REQUIRE(csv_batch_total_fields(batch) == 2);

  const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
  const auto len = static_cast<size_t>(csv_batch_data_len(batch));
  REQUIRE(std::string(data, len).find("Jo\xC3\xA3o") != std::string::npos);

  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI decodes full latin1 high range to utf8") {
  std::vector<uint8_t> input;
  std::string expected;
  for (uint16_t value = 0x80; value <= 0xFF; ++value) {
    const auto byte = static_cast<uint8_t>(value);
    input.push_back(byte);
    expected.push_back(static_cast<char>(0xC0 | (byte >> 6)));
    expected.push_back(static_cast<char>(0x80 | (byte & 0x3F)));
  }
  input.push_back('\n');

  void* parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, input.data(), input.size(), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 1);
  REQUIRE(csv_batch_total_fields(batch) == 1);

  const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
  const auto len = static_cast<size_t>(csv_batch_data_len(batch));
  REQUIRE(std::string(data, len) == expected);

  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI decodes latin1 SIMD tails and mixed runs") {
  for (const size_t len : {15, 16, 17, 31, 32, 33, 63, 64, 65}) {
    std::vector<uint8_t> input(len, 0xE1);
    const std::string expected = decode_latin1_reference(input.data(), input.size());
    input.push_back('\n');

    void* parser = csv_parser_create(1, ',');
    REQUIRE(parser != nullptr);
    void* batch = csv_parser_write_batch(parser, input.data(), input.size(), true);
    csv_parser_destroy(parser);

    REQUIRE(batch != nullptr);
    REQUIRE(csv_batch_row_count(batch) == 1);
    const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
    const auto data_len = static_cast<size_t>(csv_batch_data_len(batch));
    REQUIRE(std::string(data, data_len) == expected);
    csv_batch_destroy(batch);
  }

  std::vector<uint8_t> mixed;
  mixed.insert(mixed.end(), 15, 'A');
  mixed.insert(mixed.end(), 16, 0x80);
  mixed.push_back('B');
  mixed.insert(mixed.end(), 17, 0xFF);
  mixed.insert(mixed.end(), 31, 'C');
  mixed.push_back(0x81);
  const std::string expected = decode_latin1_reference(mixed.data(), mixed.size());

  for (const size_t chunk_size : {1, 15, 16, 17, 31, 32, 33}) {
    void* parser = csv_parser_create(1, ',');
    REQUIRE(parser != nullptr);
    for (size_t offset = 0; offset < mixed.size(); offset += chunk_size) {
      const size_t len = std::min(chunk_size, mixed.size() - offset);
      void* partial = csv_parser_write_batch(parser, mixed.data() + offset, len, false);
      REQUIRE(partial != nullptr);
      REQUIRE(csv_batch_row_count(partial) == 0);
      csv_batch_destroy(partial);
    }

    static constexpr uint8_t newline = '\n';
    void* batch = csv_parser_write_batch(parser, &newline, 1, true);
    csv_parser_destroy(parser);
    REQUIRE(batch != nullptr);
    REQUIRE(csv_batch_row_count(batch) == 1);
    const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
    const auto data_len = static_cast<size_t>(csv_batch_data_len(batch));
    REQUIRE(std::string(data, data_len) == expected);
    csv_batch_destroy(batch);
  }
}

TEST_CASE("native C ABI batch parses dense escaped quotes before close") {
  std::string escaped_quotes;
  for (int i = 0; i < 96; ++i) {
    escaped_quotes += "\"\"";
  }

  const std::string input =
      "\"id\";\"payload\";\"tail\"\r\n\"1\";\"" + escaped_quotes + "end\";\"after\"\r\n\"2\";\"plain\";\"last\"\n";

  void* parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 3);
  REQUIRE(csv_batch_total_fields(batch) == 9);

  const auto* data = reinterpret_cast<const char*>(csv_batch_data_ptr(batch));
  const auto len = static_cast<size_t>(csv_batch_data_len(batch));
  const std::string values(data, len);
  REQUIRE(values.find(std::string(96, '"') + "end") != std::string::npos);
  REQUIRE(values.find("after") != std::string::npos);
  REQUIRE(values.find("last") != std::string::npos);

  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI fixed batch allows quoted newlines") {
  const std::string first = "\"1\";\"Ana\nA\";\"S";
  const std::string second = "P\"\n\"2\";\"Joao\";\"RJ\"\n";

  void* parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);
  void* first_batch =
      csv_parser_write_fixed_batch(parser, reinterpret_cast<const uint8_t*>(first.data()), first.size(), false, 3);
  REQUIRE(first_batch != nullptr);
  REQUIRE(csv_batch_row_count(first_batch) == 0);
  csv_batch_destroy(first_batch);

  void* second_batch =
      csv_parser_write_fixed_batch(parser, reinterpret_cast<const uint8_t*>(second.data()), second.size(), false, 3);
  REQUIRE(second_batch != nullptr);
  REQUIRE(csv_batch_row_count(second_batch) == 2);
  REQUIRE(csv_batch_total_fields(second_batch) == 6);

  void* end_batch = csv_parser_finish_fixed_batch(parser, 3);
  csv_parser_destroy(parser);
  REQUIRE(end_batch != nullptr);
  REQUIRE(csv_batch_row_count(end_batch) == 0);

  csv_batch_destroy(second_batch);
  csv_batch_destroy(end_batch);
}

TEST_CASE("native C ABI exposes 64-bit batch offsets") {
  const std::string input = "a,b\n";
  void* parser = csv_parser_create(0, ',');
  REQUIRE(parser != nullptr);
  void* batch = csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), input.size(), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  const uint64_t* row_offsets = csv_batch_row_offsets_ptr(batch);
  const uint64_t* field_offsets = csv_batch_field_offsets_ptr(batch);
  REQUIRE(row_offsets != nullptr);
  REQUIRE(field_offsets != nullptr);
  REQUIRE(row_offsets[0] == 0);
  REQUIRE(row_offsets[1] == 2);
  REQUIRE(field_offsets[0] == 0);
  REQUIRE(field_offsets[1] == 1);
  REQUIRE(field_offsets[2] == 2);
  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI validates projection limits before allocation") {
  SECTION("maximum projection length and column index are accepted") {
    std::vector<uint32_t> selected_columns(2024);
    for (uint32_t index = 0; index < selected_columns.size(); ++index) {
      selected_columns[index] = index;
    }
    selected_columns.back() = 2024;

    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    void* batch = csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns.data(),
                                                   selected_columns.size(), false, 0, nullptr, 0);
    REQUIRE(batch != nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
    csv_batch_destroy(batch);
    csv_parser_destroy(parser);
  }

  SECTION("projection length above maximum is rejected") {
    std::vector<uint32_t> selected_columns(2025);
    for (uint32_t index = 0; index < selected_columns.size(); ++index) {
      selected_columns[index] = index;
    }

    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns.data(),
                                             selected_columns.size(), false, 0, nullptr, 0) == nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("length") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("duplicate projected columns are rejected") {
    const uint32_t selected_columns[] = {2, 2};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns,
                                             std::size(selected_columns), false, 0, nullptr, 0) == nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("duplicates") != std::string_view::npos);
    csv_parser_destroy(parser);
  }

  SECTION("column index above maximum is rejected") {
    const uint32_t selected_columns[] = {2025};
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_projected_batch(parser, nullptr, 0, true, true, selected_columns,
                                             std::size(selected_columns), false, 0, nullptr, 0) == nullptr);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("2024") != std::string_view::npos);
    csv_parser_destroy(parser);
  }
}

TEST_CASE("native C ABI validates filter column indexes") {
  SECTION("maximum filter column index is accepted") {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_equals(parser, nullptr, 0, true, 2024, nullptr, 0) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).empty());
    csv_parser_destroy(parser);
  }

  SECTION("filter column index above maximum is rejected") {
    void* parser = csv_parser_create(0, ',');
    REQUIRE(parser != nullptr);
    REQUIRE(csv_parser_write_count_where_equals(parser, nullptr, 0, true, 2025, nullptr, 0) == 0);
    REQUIRE(std::string_view(csv_parser_last_error(parser)).find("2024") != std::string_view::npos);
    csv_parser_destroy(parser);
  }
}

TEST_CASE("native C ABI fuzzes deterministic byte streams across parser modes") {
  for (uint32_t seed = 1; seed <= 50; ++seed) {
    const std::string input = make_fuzz_bytes(seed);
    fuzz_batch_mode(input, false);
    fuzz_batch_mode(input, true);
    fuzz_fixed_mode(input);
    fuzz_count_mode(input);
  }
}
