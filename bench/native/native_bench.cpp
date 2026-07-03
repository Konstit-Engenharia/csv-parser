#include <mitata.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <regex>
#include <string>
#include <vector>

extern "C" {
void* csv_parser_create(int encoding, uint8_t delimiter);
void csv_parser_destroy(void* parser);
void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_write_projected_batch(
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
);
void* csv_parser_write_dictionary_batch(void* parser, const uint8_t* data, uint64_t len, bool final, uint32_t column);
uint64_t csv_parser_write_group_by_count(void* parser, const uint8_t* data, uint64_t len, uint32_t column);
void* csv_parser_finish_group_by_count(void* parser, uint32_t column);
uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final);
uint64_t csv_parser_write_count_where_equals(
  void* parser,
  const uint8_t* data,
  uint64_t len,
  bool final,
  uint32_t filter_column,
  const uint8_t* filter_value,
  uint64_t filter_value_len
);
void csv_batch_destroy(void* batch);
void csv_dictionary_batch_destroy(void* batch);
void csv_group_by_count_batch_destroy(void* batch);
uint64_t csv_batch_row_count(void* batch);
uint64_t csv_batch_total_fields(void* batch);
uint64_t csv_dictionary_batch_row_count(void* batch);
uint64_t csv_dictionary_batch_dict_count(void* batch);
uint64_t csv_group_by_count_batch_row_count(void* batch);
uint64_t csv_group_by_count_batch_dict_count(void* batch);
}

namespace {

constexpr uint8_t kDelimiter = ';';
constexpr uint32_t kDictionaryColumn = 19;
constexpr uint32_t kGroupByColumn = 19;
constexpr uint32_t kFilterColumn = 19;
constexpr uint8_t kFilterValue[] = {'S', 'P'};
constexpr uint32_t kSelectedColumns[] = {0, 4, 19};
constexpr uint64_t kDefaultBytes = 256ull * 1024ull * 1024ull;

std::vector<uint8_t> g_input;
volatile uint64_t g_sink = 0;

[[noreturn]] void fail(const std::string& message) {
  std::cerr << "native bench error: " << message << std::endl;
  std::abort();
}

uint64_t parse_u64_env(const char* name, uint64_t fallback) {
  const char* value = std::getenv(name);
  if (value == nullptr || value[0] == '\0') {
    return fallback;
  }

  char* end = nullptr;
  const auto parsed = std::strtoull(value, &end, 10);
  if (end == value || (end != nullptr && end[0] != '\0')) {
    fail(std::string("invalid ") + name + ": " + value);
  }
  return parsed;
}

std::string string_env(const char* name, const char* fallback) {
  const char* value = std::getenv(name);
  return value == nullptr || value[0] == '\0' ? std::string(fallback) : std::string(value);
}

std::vector<uint8_t> read_input(const std::string& path, uint64_t byte_limit) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    fail("could not open " + path);
  }

  file.seekg(0, std::ios::end);
  const auto size = file.tellg();
  if (size < 0) {
    fail("could not stat " + path);
  }
  file.seekg(0, std::ios::beg);

  const auto available = static_cast<uint64_t>(size);
  const auto wanted = byte_limit == 0 ? available : std::min(byte_limit, available);
  std::vector<uint8_t> data(static_cast<size_t>(wanted));
  if (!data.empty()) {
    file.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(data.size()));
    if (file.gcount() != static_cast<std::streamsize>(data.size())) {
      fail("short read from " + path);
    }
  }
  return data;
}

void* new_parser() {
  void* parser = csv_parser_create(0, kDelimiter);
  if (parser == nullptr) {
    fail("csv_parser_create returned null");
  }
  return parser;
}

void consume(uint64_t value) {
  g_sink ^= value + 0x9e3779b97f4a7c15ull + (g_sink << 6) + (g_sink >> 2);
}

void bench_count() {
  void* parser = new_parser();
  const uint64_t rows = csv_parser_write_count(parser, g_input.data(), g_input.size(), true);
  csv_parser_destroy(parser);
  if (rows == 0) {
    fail("count returned 0 rows");
  }
  consume(rows);
}

void bench_filter_count() {
  void* parser = new_parser();
  const uint64_t rows = csv_parser_write_count_where_equals(
    parser,
    g_input.data(),
    g_input.size(),
    true,
    kFilterColumn,
    kFilterValue,
    sizeof(kFilterValue)
  );
  csv_parser_destroy(parser);
  consume(rows);
}

void bench_binary_batch() {
  void* parser = new_parser();
  void* batch = csv_parser_write_batch(parser, g_input.data(), g_input.size(), true);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("csv_parser_write_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

void bench_dictionary() {
  void* parser = new_parser();
  void* batch = csv_parser_write_dictionary_batch(parser, g_input.data(), g_input.size(), true, kDictionaryColumn);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("csv_parser_write_dictionary_batch returned null");
  }
  consume(csv_dictionary_batch_row_count(batch));
  consume(csv_dictionary_batch_dict_count(batch));
  csv_dictionary_batch_destroy(batch);
}

void bench_group_by_count() {
  void* parser = new_parser();
  csv_parser_write_group_by_count(parser, g_input.data(), g_input.size(), kGroupByColumn);
  void* batch = csv_parser_finish_group_by_count(parser, kGroupByColumn);
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("csv_parser_finish_group_by_count returned null");
  }
  consume(csv_group_by_count_batch_row_count(batch));
  consume(csv_group_by_count_batch_dict_count(batch));
  csv_group_by_count_batch_destroy(batch);
}

void bench_project_filter() {
  void* parser = new_parser();
  void* batch = csv_parser_write_projected_batch(
    parser,
    g_input.data(),
    g_input.size(),
    true,
    true,
    kSelectedColumns,
    sizeof(kSelectedColumns) / sizeof(kSelectedColumns[0]),
    true,
    kFilterColumn,
    kFilterValue,
    sizeof(kFilterValue)
  );
  csv_parser_destroy(parser);
  if (batch == nullptr) {
    fail("csv_parser_write_projected_batch returned null");
  }
  consume(csv_batch_row_count(batch));
  consume(csv_batch_total_fields(batch));
  csv_batch_destroy(batch);
}

}  // namespace

int main() {
  const auto path = string_env("CSV_NATIVE_BENCH_FILE", "example.csv");
  const auto byte_limit = parse_u64_env("CSV_NATIVE_BENCH_BYTES", kDefaultBytes);
  const auto filter = string_env("CSV_NATIVE_BENCH_FILTER", ".*");
  const auto format = string_env("CSV_NATIVE_BENCH_FORMAT", "mitata");
  g_input = read_input(path, byte_limit);
  if (g_input.empty()) {
    fail("input is empty");
  }

  std::cerr << "native bench input: " << path << " bytes=" << g_input.size() << std::endl;

  mitata::runner runner;
  auto* count = runner.bench("native count", bench_count);
  count->baseline();
  runner.bench("native filter count", bench_filter_count);
  runner.bench("native binary batch", bench_binary_batch);
  runner.bench("native dictionary column", bench_dictionary);
  runner.bench("native groupby count", bench_group_by_count);
  runner.bench("native projected filter", bench_project_filter);

  mitata::k_run options;
  options.colors = std::getenv("NO_COLOR") == nullptr;
  options.format = format;
  options.filter = std::regex(filter);
  runner.run(options);

  if (g_sink == 0) {
    std::cerr << "native bench sink=" << g_sink << std::endl;
  }
  return 0;
}
