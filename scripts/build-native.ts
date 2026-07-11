import {
  join,
  resolve,
} from 'node:path';
import {
  type NativeBuildTarget,
  nativeBuildTargets,
  repoRoot,
} from './native-target.ts';

const vcpkgRootEnv = process.env['VCPKG_ROOT'];

if (vcpkgRootEnv === undefined || vcpkgRootEnv.length === 0) {
  throw new Error('VCPKG_ROOT is required for native build');
}

const vcpkgRoot = vcpkgRootEnv;

for (const target of nativeBuildTargets()) {
  configure(target);
  build(target);
}

function configure(target: NativeBuildTarget): void {
  const args = [
    '-S',
    repoRoot,
    '-B',
    buildDir(target),
    '-G',
    'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCSV_NATIVE_PORTABLE=ON',
    `-DCMAKE_TOOLCHAIN_FILE=${resolve(vcpkgRoot, 'scripts/buildsystems/vcpkg.cmake')}`,
  ];

  if (target.osxArchitecture !== undefined) {
    args.push(`-DCMAKE_OSX_ARCHITECTURES=${target.osxArchitecture}`);
    args.push('-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0');
  }

  if (target.vcpkgTriplet !== undefined) {
    args.push(`-DVCPKG_TARGET_TRIPLET=${target.vcpkgTriplet}`);
  }

  run('cmake', args);
}

function build(target: NativeBuildTarget): void {
  run('cmake', ['--build', buildDir(target), '--config', 'Release']);
}

function buildDir(target: NativeBuildTarget): string {
  return join(repoRoot, 'build', target.name);
}

function run(cmd: string, args: string[]): void {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const result = Bun.spawnSync({
    cmd: [cmd, ...args],
    cwd: repoRoot,
    stderr: 'inherit',
    stdout: 'inherit',
  });

  if (!result.success) {
    throw new Error(`${cmd} failed with exit code ${String(result.exitCode)}`);
  }
}
