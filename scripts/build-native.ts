// Configures and builds release native libraries for every target supported by the current host.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type NativeBuildTarget,
  nativeBuildTargets,
  repoRoot,
} from './native-target.ts';

for (const target of nativeBuildTargets()) {
  if (!isConfigured(target)) {
    configure(target);
  }
  build(target);
}

function isConfigured(target: NativeBuildTarget): boolean {
  return existsSync(join(repoRoot, 'build', target.name, 'CMakeCache.txt'));
}

function configure(target: NativeBuildTarget): void {
  run('cmake', ['--preset', target.releasePreset]);
}

function build(target: NativeBuildTarget): void {
  run('cmake', ['--build', '--preset', target.releasePreset]);
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
