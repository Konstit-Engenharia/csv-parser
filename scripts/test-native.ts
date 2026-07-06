import {
  currentNativeBuildDir,
  repoRoot,
} from './native-target.ts';

const result = Bun.spawnSync({
  cmd: ['ctest', '--test-dir', currentNativeBuildDir(), '--output-on-failure'],
  cwd: repoRoot,
  stderr: 'inherit',
  stdout: 'inherit',
});

if (!result.success) {
  throw new Error(`ctest failed with exit code ${String(result.exitCode)}`);
}
