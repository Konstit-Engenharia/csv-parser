// Copies built native libraries into their target-specific package prebuild directories.
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  nativeBuildTargets,
  nativeLibraryFileName,
  repoRoot,
} from './native-target.ts';

const requestedTargets = process.argv.slice(2);
const targets = requestedTargets.length > 0
  ? requestedTargets
  : nativeBuildTargets().map((target) => target.name);

for (const target of targets) {
  await stageTarget(target);
}

async function stageTarget(target: string): Promise<void> {
  const fileName = nativeLibraryFileName(target);
  const source = [
    join(repoRoot, 'build', target, fileName),
    join(repoRoot, 'build', target, 'Release', fileName),
  ].find((candidate) => existsSync(candidate));

  if (source === undefined) {
    throw new Error(`native library not found for ${target}; run bun run build:native on that platform first`);
  }

  const destinationDir = join(repoRoot, 'prebuilds', target);
  const destination = join(destinationDir, fileName);
  await mkdir(destinationDir, { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  console.log(`${target}: ${destination}`);
}
