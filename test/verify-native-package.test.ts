import {
  afterEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  nativeLibraryFileName,
  packagedNativeTargets,
  repoRoot,
} from '../scripts/native-target.ts';
import {
  collectNativeSourceInputs,
  createNativePackageManifest,
  verifyNativeAttestations,
  verifyNativePackage,
  writeNativePackageManifest,
} from '../scripts/verify-native-package.ts';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('native package provenance', () => {
  test('verifies the exact tracked prebuild and source metadata', async () => {
    const root = await createFixture();

    await verifyNativePackage(root);
  });

  test('rejects a same-size binary with a different SHA-256 digest', async () => {
    const root = await createFixture();
    const binaryPath = join(root, 'prebuilds', 'linux-x64', nativeLibraryFileName('linux-x64'));
    const bytes = new Uint8Array(await Bun.file(binaryPath).arrayBuffer());
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await Bun.write(binaryPath, bytes);

    expect((await rejectionOf(verifyNativePackage(root))).message).toContain(
      'prebuilds/linux-x64/libcsv_native.so SHA-256 does not match',
    );
  });

  test('rejects changed native source inputs', async () => {
    const root = await createFixture();
    const sourcePath = join(root, 'native', 'runtime.cpp');
    await Bun.write(sourcePath, `${await Bun.file(sourcePath).text()}\n// changed after the prebuild was recorded\n`);

    expect((await rejectionOf(verifyNativePackage(root))).message).toContain(
      'native source inputs do not match prebuilds/manifest.json',
    );
  });

  test('rejects unexpected prebuild files', async () => {
    const root = await createFixture();
    await Bun.write(join(root, 'prebuilds', 'darwin-arm64', 'unexpected.dylib'), 'unexpected');

    expect((await rejectionOf(verifyNativePackage(root))).message).toContain(
      'prebuilds/darwin-arm64 must contain only libcsv_native.dylib; found: libcsv_native.dylib, unexpected.dylib',
    );
  });

  test('rejects an incomplete manifest target inventory', async () => {
    const root = await createFixture();
    const manifest = await createNativePackageManifest(root);
    manifest.targets.pop();
    await Bun.write(join(root, 'prebuilds', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    expect((await rejectionOf(verifyNativePackage(root))).message).toContain(
      'target inventory does not match the package; missing: linux-x64',
    );
  });

  test('requires trusted build attestations before publication', async () => {
    const root = await createFixture();

    expect((await rejectionOf(verifyNativeAttestations(root, 'Konstit-Engenharia/csv-parser'))).message).toContain(
      'tracked prebuild attestations are required before publication',
    );
  });
});

async function createFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'csv-native-provenance-'));
  temporaryRoots.push(root);

  for (const relativePath of await collectNativeSourceInputs()) {
    await copyFixtureFile(relativePath, root);
  }
  for (const target of packagedNativeTargets) {
    await copyFixtureFile(`prebuilds/${target}/${nativeLibraryFileName(target)}`, root);
  }
  await writeNativePackageManifest(root);
  return root;
}

async function copyFixtureFile(relativePath: string, fixtureRoot: string): Promise<void> {
  const destination = join(fixtureRoot, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(repoRoot, relativePath), destination);
}

async function rejectionOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error('expected operation to reject');
}
