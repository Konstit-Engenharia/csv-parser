import { join } from 'node:path';
import {
  currentNativeBuildDir,
  nativeExecutableName,
  repoRoot,
} from './native-target.ts';

const benchPath = join(currentNativeBuildDir(), nativeExecutableName('csv_native_bench'));
const result = Bun.spawnSync({
  cmd: [benchPath],
  cwd: repoRoot,
  stderr: 'inherit',
  stdout: 'inherit',
});

if (!result.success) {
  throw new Error(`native benchmark failed with exit code ${String(result.exitCode)}`);
}
