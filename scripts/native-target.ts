import {
  dirname,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeBuildTarget {
  name: string;
  osxArchitecture?: string;
  vcpkgTriplet?: string;
}

export const packagedNativeTargets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
] as const;

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function currentNativeTargetName(): string {
  return `${process.platform}-${process.arch}`;
}

export function currentNativeBuildDir(): string {
  return join(repoRoot, 'build', currentNativeTargetName());
}

export function nativeLibraryBaseName(): string {
  return process.platform === 'win32' ? 'csv_native' : 'libcsv_native';
}

export function nativeLibraryFileName(target: string): string {
  if (target.startsWith('darwin-')) {
    return 'libcsv_native.dylib';
  }
  if (target.startsWith('linux-')) {
    return 'libcsv_native.so';
  }
  if (target.startsWith('win32-')) {
    return 'csv_native.dll';
  }
  throw new Error(`unsupported native target: ${target}`);
}

export function nativeExecutableName(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

export function nativeBuildTargets(): NativeBuildTarget[] {
  if (process.platform === 'darwin') {
    return [
      {
        name: 'darwin-arm64',
        osxArchitecture: 'arm64',
        vcpkgTriplet: 'arm64-osx',
      },
      {
        name: 'darwin-x64',
        osxArchitecture: 'x86_64',
        vcpkgTriplet: 'x64-osx',
      },
    ];
  }

  return [{
    name: currentNativeTargetName(),
  }];
}
