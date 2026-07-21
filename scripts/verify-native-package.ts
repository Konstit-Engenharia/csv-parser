// Verifies that packaged native libraries exist and match their target binary formats.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  nativeLibraryFileName,
  packagedNativeTargets,
  repoRoot,
} from './native-target.ts';

const configuredTargets = process.env['CSV_NATIVE_PACKAGE_TARGETS'];
const targets = configuredTargets === undefined
  ? [...packagedNativeTargets]
  : configuredTargets.split(',').map((target) => target.trim()).filter((target) => target.length > 0);

if (targets.length === 0) {
  throw new Error('CSV_NATIVE_PACKAGE_TARGETS must contain at least one target');
}

for (const target of targets) {
  const fileName = nativeLibraryFileName(target);
  const path = join(repoRoot, 'prebuilds', target, fileName);
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile() || info.size < 32) {
    throw new Error(`missing packaged native library: prebuilds/${target}/${fileName}`);
  }
  await verifyBinaryFormat(path, target);
  console.log(`${target}: ${String(info.size)} bytes`);
}

async function verifyBinaryFormat(path: string, target: string): Promise<void> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const isElf = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  const isMachO = bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe;
  if (target.startsWith('linux-') && !isElf) {
    throw new Error(`${target} library is not an ELF binary`);
  }
  if (target.startsWith('darwin-') && !isMachO) {
    throw new Error(`${target} library is not a Mach-O binary`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (target === 'linux-x64' && view.getUint16(18, true) !== 0x3e) {
    throw new Error(`${target} library does not contain x64 machine code`);
  }
  if (target === 'darwin-x64' && view.getUint32(4, true) !== 0x01000007) {
    throw new Error(`${target} library does not contain x64 machine code`);
  }
  if (target === 'darwin-arm64' && view.getUint32(4, true) !== 0x0100000c) {
    throw new Error(`${target} library does not contain ARM64 machine code`);
  }
  if (target.startsWith('darwin-')) {
    verifyMacOsDeploymentTarget(view, target);
  }
}

function verifyMacOsDeploymentTarget(view: DataView, target: string): void {
  const loadCommandCount = view.getUint32(16, true);
  let offset = 32;
  for (let index = 0; index < loadCommandCount; ++index) {
    const command = view.getUint32(offset, true);
    const commandSize = view.getUint32(offset + 4, true);
    if (commandSize < 8 || offset + commandSize > view.byteLength) {
      throw new Error(`${target} contains an invalid Mach-O load command`);
    }
    if (command === 0x32) {
      const minimumVersion = view.getUint32(offset + 12, true);
      if (minimumVersion > 0x000d0000) {
        throw new Error(`${target} requires macOS newer than 13.0`);
      }
      return;
    }
    offset += commandSize;
  }
  throw new Error(`${target} does not declare a macOS deployment target`);
}
