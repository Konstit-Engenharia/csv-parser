cmake_minimum_required(VERSION 3.25)

project(bun_csv_parser LANGUAGES CXX)

include(CTest)

option(CSV_NATIVE_SANITIZERS "Build native targets with sanitizers" OFF)
option(CSV_NATIVE_PORTABLE "Build portable binaries suitable for package distribution" ON)
set(CSV_NATIVE_SANITIZER_LIST "address,undefined" CACHE STRING "Comma-separated sanitizer list for native sanitizer builds")

find_package(Catch2 CONFIG REQUIRED)
find_package(hwy CONFIG REQUIRED)
find_package(unordered_dense CONFIG REQUIRED)
find_package(unofficial-vincentlaucsb-csv-parser CONFIG REQUIRED)

add_library(csv_native SHARED
  native/csv_parser.cpp
)

target_compile_features(csv_native PRIVATE cxx_std_20)

set(CSV_NATIVE_CPU_FLAGS)
if(NOT CSV_NATIVE_PORTABLE)
  if(APPLE)
    if(CMAKE_OSX_ARCHITECTURES MATCHES "x86_64")
      set(CSV_NATIVE_CPU_FLAGS -mavx2 -mfma -mpopcnt)
    elseif(CMAKE_OSX_ARCHITECTURES MATCHES "arm64")
      set(CSV_NATIVE_CPU_FLAGS -mcpu=apple-m1)
    endif()
  elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64|x86_64|amd64|AMD64)")
    set(CSV_NATIVE_CPU_FLAGS -march=native)
  endif()
endif()

set(CSV_NATIVE_OPTIMIZED_FLAGS -O3 -DNDEBUG -fomit-frame-pointer -funroll-loops ${CSV_NATIVE_CPU_FLAGS})
set(CSV_NATIVE_SANITIZER_FLAGS -O1 -g -fno-omit-frame-pointer -fsanitize=${CSV_NATIVE_SANITIZER_LIST} -fno-sanitize-recover=all)

function(csv_native_target_options target)
  target_compile_options(${target} PRIVATE
    $<$<AND:$<CXX_COMPILER_ID:AppleClang,Clang,GNU>,$<BOOL:${CSV_NATIVE_SANITIZERS}>>:${CSV_NATIVE_SANITIZER_FLAGS}>
    $<$<AND:$<CXX_COMPILER_ID:AppleClang,Clang,GNU>,$<NOT:$<BOOL:${CSV_NATIVE_SANITIZERS}>>>:${CSV_NATIVE_OPTIMIZED_FLAGS}>
    $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-Wall -Wextra -Wpedantic>
  )
  target_link_options(${target} PRIVATE
    $<$<AND:$<CXX_COMPILER_ID:AppleClang,Clang,GNU>,$<BOOL:${CSV_NATIVE_SANITIZERS}>>:-fsanitize=${CSV_NATIVE_SANITIZER_LIST}>
  )
endfunction()

csv_native_target_options(csv_native)
target_compile_options(csv_native PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-fno-exceptions -fno-rtti>
)
target_link_options(csv_native PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-fno-exceptions -fno-rtti>
)
target_link_libraries(csv_native PRIVATE hwy::hwy unordered_dense::unordered_dense)

set_target_properties(csv_native PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  POSITION_INDEPENDENT_CODE ON
  INTERPROCEDURAL_OPTIMIZATION_RELEASE ON
)

add_executable(csv_native_bench
  bench/native/native_bench.cpp
)

target_compile_features(csv_native_bench PRIVATE cxx_std_20)
target_include_directories(csv_native_bench SYSTEM PRIVATE
  bench/native
)
csv_native_target_options(csv_native_bench)
target_compile_options(csv_native_bench PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-fno-rtti>
)
target_link_options(csv_native_bench PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-fno-rtti>
)
target_link_libraries(csv_native_bench PRIVATE
  csv_native
  unofficial::vincentlaucsb-csv-parser::csv
)
set_target_properties(csv_native_bench PROPERTIES
  INTERPROCEDURAL_OPTIMIZATION_RELEASE ON
)

add_executable(csv_native_tests
  test/native_csv_cxx_test.cpp
)

target_compile_features(csv_native_tests PRIVATE cxx_std_20)
csv_native_target_options(csv_native_tests)
target_link_libraries(csv_native_tests PRIVATE csv_native Catch2::Catch2WithMain)

add_test(NAME csv_native_tests COMMAND csv_native_tests)

add_executable(csv_native_fuzz
  test/native_csv_fuzz.cpp
)

target_compile_features(csv_native_fuzz PRIVATE cxx_std_20)
csv_native_target_options(csv_native_fuzz)
target_link_libraries(csv_native_fuzz PRIVATE csv_native)

add_test(NAME csv_native_fuzz COMMAND csv_native_fuzz)
