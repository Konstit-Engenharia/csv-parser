import {
  type NativeBuildTarget,
  nativeBuildTargets,
  repoRoot,
} from './native-target.ts';

for (const target of nativeBuildTargets()) {
  configure(target);
  build(target);
}

function configure(target: NativeBuildTarget): void {
  run('cmake', ['--fresh', '--preset', target.releasePreset]);
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
