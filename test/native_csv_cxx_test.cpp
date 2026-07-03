#include <catch2/catch_test_macros.hpp>

#include <cstdint>
#include <cstring>
#include <string>
#include <string_view>

extern "C" {
void *csv_parser_create(int encoding, uint8_t delimiter);
void csv_parser_destroy(void *parser);
void *csv_parser_write_batch(void *parser, const uint8_t *data, uint64_t len,
                             bool final);
void *csv_parser_finish_batch(void *parser);
void *csv_parser_write_dictionary_batch(void *parser, const uint8_t *data,
                                        uint64_t len, bool final,
                                        uint32_t column);
uint64_t csv_parser_write_group_by_count(void *parser, const uint8_t *data,
                                         uint64_t len, uint32_t column);
void *csv_parser_finish_group_by_count(void *parser, uint32_t column);
uint64_t csv_parser_write_count(void *parser, const uint8_t *data, uint64_t len,
                                bool final);
uint64_t csv_parser_finish_count(void *parser);
void csv_batch_destroy(void *batch);
void csv_dictionary_batch_destroy(void *batch);
void csv_group_by_count_batch_destroy(void *batch);
uint64_t csv_batch_row_count(void *batch);
uint64_t csv_batch_total_fields(void *batch);
uint64_t csv_batch_data_len(void *batch);
const uint8_t *csv_batch_data_ptr(void *batch);
uint64_t csv_dictionary_batch_row_count(void *batch);
uint64_t csv_dictionary_batch_dict_count(void *batch);
const uint32_t *csv_dictionary_batch_ids_ptr(void *batch);
uint64_t csv_group_by_count_batch_row_count(void *batch);
uint64_t csv_group_by_count_batch_dict_count(void *batch);
const uint64_t *csv_group_by_count_batch_counts_ptr(void *batch);
}

namespace {

void write_count_chunk(void *parser, std::string_view chunk, uint64_t &rows) {
  rows += csv_parser_write_count(
      parser, reinterpret_cast<const uint8_t *>(chunk.data()), chunk.size(),
      false);
}

} // namespace

TEST_CASE("native C ABI counts chunked quoted rows") {
  void *parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);

  uint64_t rows = 0;
  write_count_chunk(parser, "\"id\";\"uf\"\n\"1\";\"SP\"\n\"2\";\"", rows);
  write_count_chunk(parser, "RJ\"\n\"3\";\"S\nP\"", rows);
  rows += csv_parser_finish_count(parser);

  csv_parser_destroy(parser);

  REQUIRE(rows == 4);
}

TEST_CASE("native C ABI decodes latin1 batches to utf8") {
  const uint8_t input[] = {
      'n', 'a', 'm', 'e', '\n', 'J', 'o', 0xE3, 'o', '\n',
  };

  void *parser = csv_parser_create(1, ',');
  REQUIRE(parser != nullptr);
  void *batch = csv_parser_write_batch(parser, input, sizeof(input), true);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_batch_row_count(batch) == 2);
  REQUIRE(csv_batch_total_fields(batch) == 2);

  const auto *data = reinterpret_cast<const char *>(csv_batch_data_ptr(batch));
  const auto len = static_cast<size_t>(csv_batch_data_len(batch));
  REQUIRE(std::string(data, len).find("Jo\xC3\xA3o") != std::string::npos);

  csv_batch_destroy(batch);
}

TEST_CASE("native C ABI dictionary returns ids and unique values") {
  const std::string input =
      "\"id\";\"uf\"\n\"1\";\"SP\"\n\"2\";\"SP\"\n\"3\";\"RJ\"\n";

  void *parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);
  void *batch = csv_parser_write_dictionary_batch(
      parser, reinterpret_cast<const uint8_t *>(input.data()), input.size(),
      true, 1);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_dictionary_batch_row_count(batch) == 4);
  REQUIRE(csv_dictionary_batch_dict_count(batch) == 3);

  const uint32_t *ids = csv_dictionary_batch_ids_ptr(batch);
  REQUIRE(ids != nullptr);
  REQUIRE(ids[0] == 0);
  REQUIRE(ids[1] == 1);
  REQUIRE(ids[2] == 1);
  REQUIRE(ids[3] == 2);

  csv_dictionary_batch_destroy(batch);
}

TEST_CASE("native C ABI groupBy count aggregates dictionary values") {
  const std::string first = "\"id\";\"uf\"\n\"1\";\"SP\"\n\"2\";";
  const std::string second = "\"SP\"\n\"3\";\"RJ\"\n";

  void *parser = csv_parser_create(0, ';');
  REQUIRE(parser != nullptr);
  csv_parser_write_group_by_count(
      parser, reinterpret_cast<const uint8_t *>(first.data()), first.size(), 1);
  csv_parser_write_group_by_count(
      parser, reinterpret_cast<const uint8_t *>(second.data()), second.size(),
      1);
  void *batch = csv_parser_finish_group_by_count(parser, 1);
  csv_parser_destroy(parser);

  REQUIRE(batch != nullptr);
  REQUIRE(csv_group_by_count_batch_row_count(batch) == 4);
  REQUIRE(csv_group_by_count_batch_dict_count(batch) == 3);

  const uint64_t *counts = csv_group_by_count_batch_counts_ptr(batch);
  REQUIRE(counts != nullptr);
  REQUIRE(counts[0] == 1);
  REQUIRE(counts[1] == 2);
  REQUIRE(counts[2] == 1);

  csv_group_by_count_batch_destroy(batch);
}
