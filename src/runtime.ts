import { native } from './native.js';

export function requireBunRuntime(options?: {
  readonly architecture?: string;
  readonly avx2Supported?: boolean;
  readonly bunVersion: string | undefined;
}): void {
  const bunVersion = options === undefined ? process.versions.bun : options.bunVersion;
  if (bunVersion === undefined) {
    throw new Error('This package requires Bun');
  }

  const architecture = options?.architecture ?? process.arch;
  if (architecture !== 'x64') {
    return;
  }

  const avx2Supported = options?.avx2Supported ?? (native.symbols.csv_runtime_supports_avx2() !== 0);
  if (!avx2Supported) {
    throw new Error('This package requires AVX2 support on x64 CPUs');
  }
}
