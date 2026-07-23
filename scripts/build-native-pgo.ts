// Builds, trains, and rebuilds the current native target with Clang IR-based PGO.
import { Glob } from 'bun';
import {
  existsSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  currentNativeTargetName,
  nativeExecutableName,
  nativeLibraryFileName,
  repoRoot,
} from './native-target.ts';

const target = currentNativeTargetName();
const toolchain = join(repoRoot, 'toolchains', `${target}-clang.cmake`);
if (!existsSync(toolchain)) {
  throw new Error(`unsupported native PGO build target: ${target}`);
}

const buildRoot = join(repoRoot, 'build', `${target}-pgo`);
const instrumentBuildDir = join(buildRoot, 'instrument');
const profileDir = join(buildRoot, 'profiles');
const optimizedBuildDir = join(buildRoot, 'release');
const fetchContentDir = join(repoRoot, '.cache', 'fetchcontent', target);
const trainBytes = parsePositiveIntegerEnv('CSV_NATIVE_PGO_TRAIN_BYTES', 16 * 1024 * 1024);
const suppliedTrainingFile = process.env['CSV_NATIVE_PGO_TRAIN_FILE'];
const trainingFile = suppliedTrainingFile === undefined
  ? join(profileDir, 'latin1-training.csv')
  : resolve(suppliedTrainingFile);
const llvmProfdata = resolveLlvmProfdata();

if (suppliedTrainingFile !== undefined) {
  if (!existsSync(trainingFile)) {
    throw new Error(`CSV_NATIVE_PGO_TRAIN_FILE does not exist: ${trainingFile}`);
  }
  if (isWithin(buildRoot, trainingFile)) {
    throw new Error(`CSV_NATIVE_PGO_TRAIN_FILE must be outside the disposable PGO build directory: ${buildRoot}`);
  }
}

rmSync(buildRoot, { force: true, recursive: true });
mkdirSync(profileDir, { recursive: true });

if (suppliedTrainingFile === undefined) {
  await writeLatin1TrainingFile(trainingFile, trainBytes);
}

configure(instrumentBuildDir, false, [
  '-DCSV_NATIVE_PGO_INSTRUMENT=ON',
]);
build(instrumentBuildDir, ['csv_native_bench']);

const instrumentBench = join(instrumentBuildDir, nativeExecutableName('csv_native_bench'));
const rawProfilePattern = join(profileDir, 'csv-native-%p-%m.profraw');
// Keep Latin-1 as the majority (8 of 15 sessions) while giving UTF-8 batch parsing representative weight.
const trainingMix = [
  ...Array<string>(8).fill('^native latin1 batch$'),
  ...Array<string>(4).fill('^native binary batch$'),
  '^native count$',
  '^native filter count$',
  '^native projected filter$',
];

for (const filter of trainingMix) {
  run(instrumentBench, [], {
    CSV_NATIVE_BENCH_BYTES: '0',
    CSV_NATIVE_BENCH_FILE: trainingFile,
    CSV_NATIVE_BENCH_FILTER: filter,
    CSV_NATIVE_BENCH_FORMAT: 'mitata',
    LLVM_PROFILE_FILE: rawProfilePattern,
    NO_COLOR: '1',
  });
}

const rawProfiles = new Glob('*.profraw').scanSync({
  absolute: true,
  cwd: profileDir,
});
const profileInputs = Array.from(rawProfiles).sort((left, right) => left.localeCompare(right));
if (profileInputs.length === 0) {
  throw new Error(`PGO training produced no .profraw files in ${profileDir}`);
}

const profileData = join(profileDir, 'csv-native.profdata');
run(llvmProfdata, [
  'merge',
  '--output',
  profileData,
  ...profileInputs,
]);

configure(optimizedBuildDir, true, [
  `-DCSV_NATIVE_PGO_PROFILE=${profileData}`,
]);
build(optimizedBuildDir, [
  'csv_native_bench',
  'csv_native_tests',
  'csv_native_fuzz',
]);

console.log(`PGO benchmark: ${join(optimizedBuildDir, nativeExecutableName('csv_native_bench'))}`);
console.log(`PGO library: ${join(optimizedBuildDir, nativeLibraryFileName(target))}`);
console.log(`PGO profile: ${profileData}`);
console.log(`PGO tests: ctest --test-dir ${optimizedBuildDir} --output-on-failure`);

function configure(buildDir: string, buildTesting: boolean, pgoArgs: readonly string[]): void {
  run('cmake', [
    '-S',
    repoRoot,
    '-B',
    buildDir,
    '-G',
    'Ninja',
    `-DBUILD_TESTING=${buildTesting ? 'ON' : 'OFF'}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    `-DFETCHCONTENT_BASE_DIR=${fetchContentDir}`,
    ...pgoArgs,
  ]);
}

function build(buildDir: string, targets: readonly string[]): void {
  run('cmake', [
    '--build',
    buildDir,
    '--target',
    ...targets,
  ]);
}

function run(cmd: string, args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): void {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const result = Bun.spawnSync({
    cmd: [cmd, ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stderr: 'inherit',
    stdout: 'inherit',
  });

  if (!result.success) {
    throw new Error(`${cmd} failed with exit code ${String(result.exitCode)}`);
  }
}

function resolveLlvmProfdata(): string {
  const configured = process.env['CSV_NATIVE_LLVM_PROFDATA'];
  if (configured !== undefined && configured !== '') {
    return resolve(configured);
  }

  const discovered = Bun.which('llvm-profdata');
  if (discovered !== null) {
    return discovered;
  }

  if (process.platform === 'darwin') {
    const result = Bun.spawnSync({
      cmd: ['xcrun', '--find', 'llvm-profdata'],
      cwd: repoRoot,
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (result.success) {
      return result.stdout.toString().trim();
    }
  }

  throw new Error('llvm-profdata was not found; set CSV_NATIVE_LLVM_PROFDATA to its path');
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

async function writeLatin1TrainingFile(path: string, byteLimit: number): Promise<void> {
  const columns = [
    '000001',
    'caf\u00e9',
    'S\u00e3o Paulo',
    'Jo\u00e3o',
    '"produto; especial"',
    'a\u00e7\u00facar',
    'M\u00fcnchen',
    'Fran\u00e7ois',
    'ma\u00f1ana',
    'cr\u00e8me',
    'gar\u00e7on',
    'jalape\u00f1o',
    '"ele disse ""ol\u00e1"""',
    'Bogot\u00e1',
    'Andr\u00e9',
    'cora\u00e7\u00e3o',
    'informa\u00e7\u00e3o',
    'opera\u00e7\u00e3o',
    'A\u00e7ores',
    'SP',
  ];
  const rowText = `${columns.join(';')}\n`;
  const row = Uint8Array.from(rowText, (character) => character.charCodeAt(0));
  const completeRows = Math.max(1, Math.floor(byteLimit / row.length));
  const data = new Uint8Array(completeRows * row.length);
  for (let offset = 0; offset < data.length; offset += row.length) {
    data.set(row, offset);
  }
  await Bun.write(path, data);
}
