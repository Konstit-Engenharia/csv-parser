import {
  join,
  resolve,
} from 'node:path';
import {
  currentNativeTargetName,
  repoRoot,
} from './native-target.ts';

const vcpkgRootEnv = process.env['VCPKG_ROOT'];

if (vcpkgRootEnv === undefined || vcpkgRootEnv.length === 0) {
  throw new Error('VCPKG_ROOT is required for native sanitizer build');
}

const buildDir = join(repoRoot, 'build', `${currentNativeTargetName()}-sanitize`);
const sanitizerList = process.platform === 'darwin' ? 'undefined' : 'address,undefined';
const configureArgs = [
  '-S',
  repoRoot,
  '-B',
  buildDir,
  '-G',
  'Ninja',
  '-DCMAKE_BUILD_TYPE=Debug',
  '-DCSV_NATIVE_SANITIZERS=ON',
  `-DCSV_NATIVE_SANITIZER_LIST=${sanitizerList}`,
  `-DCMAKE_TOOLCHAIN_FILE=${resolve(vcpkgRootEnv, 'scripts/buildsystems/vcpkg.cmake')}`,
];

if (process.platform === 'darwin') {
  configureArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`);
  configureArgs.push(`-DVCPKG_TARGET_TRIPLET=${process.arch === 'arm64' ? 'arm64-osx' : 'x64-osx'}`);
}

run('cmake', configureArgs);
run('cmake', ['--build', buildDir, '--config', 'Debug', '--target', 'csv_native_fuzz']);
run('ctest', ['--test-dir', buildDir, '--output-on-failure', '--timeout', '60', '-R', 'csv_native_fuzz'], {
  ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1',
  UBSAN_OPTIONS: 'halt_on_error=1',
});

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const result = Bun.spawnSync({
    cmd: [cmd, ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    stderr: 'inherit',
    stdout: 'inherit',
  });

  if (!result.success) {
    throw new Error(`${cmd} failed with exit code ${String(result.exitCode)}`);
  }
}
