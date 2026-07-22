#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>

extern "C" {
void* csv_parser_create(int encoding, uint8_t delimiter);
void csv_parser_destroy(void* parser);
void* csv_parser_write_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_finish_batch(void* parser);
void* csv_parser_write_strict_batch(void* parser, const uint8_t* data, uint64_t len, bool final);
void* csv_parser_finish_strict_batch(void* parser);
void* csv_parser_write_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final, uint32_t fixed_columns);
void* csv_parser_write_trusted_fixed_batch(void* parser, const uint8_t* data, uint64_t len, bool final,
                                           uint32_t fixed_columns);
uint64_t csv_parser_write_count(void* parser, const uint8_t* data, uint64_t len, bool final);
uint64_t csv_parser_finish_count(void* parser);
void csv_batch_destroy(void* batch);
}

namespace {

uint32_t next_random(uint32_t& state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

std::string make_fuzz_bytes(uint32_t seed) {
  static constexpr uint8_t alphabet[] = {
      'a', 'b', 'c', '0', '1', ',', ';', '"', '\n', '\r', ' ', 0x80, 0xE1,
  };
  uint32_t state = seed;
  const size_t len = 1 + (next_random(state) % 512);
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

bool ensure_parser(void* parser) {
  if (parser != nullptr) {
    return true;
  }
  std::cerr << "csv_parser_create returned null" << std::endl;
  return false;
}

void fuzz_batch_mode(std::string_view input, bool strict) {
  void* parser = csv_parser_create(0, ',');
  if (!ensure_parser(parser)) {
    std::exit(1);
  }

  const size_t first_len = input.size() / 3;
  const size_t second_len = input.size() / 2;
  const size_t second_start = first_len;
  const size_t third_start = first_len + second_len;

  void* first =
      strict ? csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), first_len, false)
             : csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data()), first_len, false);
  destroy_batch_if_present(first);
  if (first == nullptr && strict) {
    csv_parser_destroy(parser);
    return;
  }

  void* second = strict ? csv_parser_write_strict_batch(
                              parser, reinterpret_cast<const uint8_t*>(input.data() + second_start), second_len, false)
                        : csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data() + second_start),
                                                 second_len, false);
  destroy_batch_if_present(second);
  if (second == nullptr && strict) {
    csv_parser_destroy(parser);
    return;
  }

  void* third =
      strict ? csv_parser_write_strict_batch(parser, reinterpret_cast<const uint8_t*>(input.data() + third_start),
                                             input.size() - third_start, false)
             : csv_parser_write_batch(parser, reinterpret_cast<const uint8_t*>(input.data() + third_start),
                                      input.size() - third_start, false);
  destroy_batch_if_present(third);
  if (third == nullptr && strict) {
    csv_parser_destroy(parser);
    return;
  }

  void* end = strict ? csv_parser_finish_strict_batch(parser) : csv_parser_finish_batch(parser);
  destroy_batch_if_present(end);
  csv_parser_destroy(parser);
}

void fuzz_fixed_mode(std::string_view input, bool trusted) {
  void* parser = csv_parser_create(0, ',');
  if (!ensure_parser(parser)) {
    std::exit(1);
  }
  void* batch = trusted ? csv_parser_write_trusted_fixed_batch(parser, reinterpret_cast<const uint8_t*>(input.data()),
                                                               input.size(), true, 3)
                        : csv_parser_write_fixed_batch(parser, reinterpret_cast<const uint8_t*>(input.data()),
                                                       input.size(), true, 3);
  destroy_batch_if_present(batch);
  csv_parser_destroy(parser);
}

void fuzz_count_mode(std::string_view input) {
  void* parser = csv_parser_create(0, ',');
  if (!ensure_parser(parser)) {
    std::exit(1);
  }
  const size_t split = input.size() / 2;
  csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(input.data()), split, false);
  csv_parser_write_count(parser, reinterpret_cast<const uint8_t*>(input.data() + split), input.size() - split, false);
  csv_parser_finish_count(parser);
  csv_parser_destroy(parser);
}

void fuzz_one(std::string_view input) {
  fuzz_batch_mode(input, false);
  fuzz_batch_mode(input, true);
  fuzz_fixed_mode(input, false);
  fuzz_fixed_mode(input, true);
  fuzz_count_mode(input);
}

} // namespace

int main() {
  for (uint32_t seed = 1; seed <= 200; ++seed) {
    fuzz_one(make_fuzz_bytes(seed));
  }
  fuzz_one("\"id\",\"name\"\n\"1\",\"Ada\"\n");
  fuzz_one("\"id\",\"name\"\n\"1\",\"unterminated");
  std::cout << "native fuzz smoke ok" << std::endl;
  return 0;
}
