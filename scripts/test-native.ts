import {
  currentNativeBuildDir,
  currentNativeTargetName,
  repoRoot,
} from './native-target.ts';

const preset = `${currentNativeTargetName()}-release`;

run('cmake', ['--fresh', '--preset', preset, '-DBUILD_TESTING=ON']);
run('cmake', ['--build', '--preset', preset, '--target', 'csv_native_tests']);
run('ctest', ['--test-dir', currentNativeBuildDir(), '--output-on-failure', '-R', '^csv_native_tests$']);

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
