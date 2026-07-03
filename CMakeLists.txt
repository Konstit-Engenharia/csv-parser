cmake_minimum_required(VERSION 3.25)

project(bun_csv_parser LANGUAGES CXX)

find_package(hwy CONFIG REQUIRED)

add_library(csv_native SHARED
  native/csv_parser.cpp
)

target_compile_features(csv_native PRIVATE cxx_std_20)

set(CSV_NATIVE_CPU_FLAGS -march=native)
if(CMAKE_SYSTEM_PROCESSOR MATCHES "^(arm64|aarch64)")
  set(CSV_NATIVE_CPU_FLAGS -mcpu=native)
endif()

target_compile_options(csv_native PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-O3 -DNDEBUG -fno-exceptions -fno-rtti -fomit-frame-pointer -funroll-loops ${CSV_NATIVE_CPU_FLAGS} -Wall -Wextra -Wpedantic>
)
target_link_options(csv_native PRIVATE
  $<$<CXX_COMPILER_ID:AppleClang,Clang,GNU>:-fno-exceptions -fno-rtti>
)
target_link_libraries(csv_native PRIVATE hwy::hwy)

set_target_properties(csv_native PROPERTIES
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  POSITION_INDEPENDENT_CODE ON
  INTERPROCEDURAL_OPTIMIZATION_RELEASE ON
)
