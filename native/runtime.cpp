#if defined(_WIN32)
#define CSV_EXPORT extern "C" __declspec(dllexport)
#else
#define CSV_EXPORT extern "C" __attribute__((visibility("default")))
#endif

#if defined(__x86_64__)
#define CSV_BASELINE_X86 __attribute__((target("no-avx,no-avx2")))
#else
#define CSV_BASELINE_X86
#endif

CSV_EXPORT CSV_BASELINE_X86 int csv_runtime_supports_avx2() {
#if defined(__x86_64__)
  __builtin_cpu_init();
  return __builtin_cpu_supports("avx2") ? 1 : 0;
#else
  return 0;
#endif
}
