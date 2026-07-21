// Rebuilds and tests the current native target with the configured sanitizers enabled.
import {
  currentNativeTargetName,
  repoRoot,
} from './native-target.ts';

const preset = `${currentNativeTargetName()}-sanitize`;

run('cmake', ['--fresh', '--preset', preset]);
run('cmake', ['--build', '--preset', preset]);
run('ctest', ['--preset', preset]);

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
