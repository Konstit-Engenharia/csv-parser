import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from './native-target.ts';

const image = 'konstit-csv-parser-linux-x64-builder:ubuntu-24.04';
const preset = 'linux-x64-release';
const dockerDirectory = join(repoRoot, 'docker');

requireDocker();
run([
  'docker',
  'build',
  '--platform',
  'linux/amd64',
  '--file',
  join(dockerDirectory, 'linux-x64.Dockerfile'),
  '--tag',
  image,
  dockerDirectory,
]);

if (!existsSync(join(repoRoot, 'build', 'linux-x64', 'CMakeCache.txt'))) {
  runInBuilder(['cmake', '--preset', preset]);
}
runInBuilder(['cmake', '--build', '--preset', preset]);

function requireDocker(): void {
  const result = Bun.spawnSync({
    cmd: ['docker', 'info'],
    cwd: repoRoot,
    stderr: 'ignore',
    stdout: 'ignore',
  });
  if (!result.success) {
    throw new Error('Docker is unavailable; install Docker and start its daemon before building the Linux x64 prebuild');
  }
}

function runInBuilder(command: readonly string[]): void {
  run([
    'docker',
    'run',
    '--platform',
    'linux/amd64',
    '--rm',
    '--mount',
    `type=bind,source=${repoRoot},target=/work`,
    '--workdir',
    '/work',
    image,
    ...command,
  ]);
}

function run(command: readonly string[]): void {
  console.log(`$ ${command.join(' ')}`);
  const result = Bun.spawnSync({
    cmd: [...command],
    cwd: repoRoot,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  if (!result.success) {
    throw new Error(`${command[0] ?? 'command'} failed with exit code ${String(result.exitCode)}`);
  }
}
