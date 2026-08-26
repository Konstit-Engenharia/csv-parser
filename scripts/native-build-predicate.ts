// Records the runner and toolchain used to produce one attested native target.
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const [target, outputPath,] = process.argv.slice(2);
if (target === undefined || outputPath === undefined || process.argv.length !== 4) {
  throw new Error('usage: bun scripts/native-build-predicate.ts <target> <output.json>');
}

const predicate = {
  schemaVersion: 1,
  target,
  runner: {
    architecture: process.env['RUNNER_ARCH'] ?? process.arch,
    image: process.env['ImageOS'] ?? process.platform,
    imageVersion: process.env['ImageVersion'] ?? 'unknown',
    operatingSystem: process.env['RUNNER_OS'] ?? process.platform,
  },
  toolchain: {
    clang: commandOutput(['clang++', '--version']),
    cmake: commandOutput(['cmake', '--version']),
    linker: process.platform === 'darwin'
      ? commandOutput(['xcrun', 'ld', '-version_details'])
      : commandOutput(['ld', '--version']),
    ninja: commandOutput(['ninja', '--version']),
    ...(process.platform === 'darwin' ? { sdk: commandOutput(['xcrun', '--show-sdk-version']) } : {}),
  },
};

await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(predicate, null, 2)}\n`);

function commandOutput(command: string[]): string {
  const result = Bun.spawnSync({
    cmd: command,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (!result.success) {
    throw new Error(`${command.join(' ')} failed with exit code ${String(result.exitCode)}`);
  }
  return result.stdout.toString().trim();
}
