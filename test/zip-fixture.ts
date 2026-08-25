import { deflateRawSync } from 'node:zlib';

interface TestZipEntry {
  crc32?: number;
  data: Uint8Array;
  dataDescriptor?: boolean;
  flags?: number;
  method: 0 | 8 | 99;
  name: string;
}

export function createZip(entries: readonly TestZipEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const compressed = entry.method === 8 ? deflateRawSync(data) : data;
    const checksum = entry.crc32 ?? Bun.hash.crc32(data);
    const flags = (entry.flags ?? 0) | (entry.dataDescriptor === true ? 1 << 3 : 0);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(entry.method, 8);
    if (entry.dataDescriptor !== true) {
      localHeader.writeUInt32LE(checksum, 14);
      localHeader.writeUInt32LE(compressed.byteLength, 18);
      localHeader.writeUInt32LE(data.byteLength, 22);
    }
    localHeader.writeUInt16LE(name.byteLength, 26);

    const dataDescriptor = entry.dataDescriptor === true ? Buffer.alloc(16) : Buffer.alloc(0);
    if (entry.dataDescriptor === true) {
      dataDescriptor.writeUInt32LE(0x08074b50, 0);
      dataDescriptor.writeUInt32LE(checksum, 4);
      dataDescriptor.writeUInt32LE(compressed.byteLength, 8);
      dataDescriptor.writeUInt32LE(data.byteLength, 12);
    }
    localParts.push(localHeader, name, compressed, dataDescriptor);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(flags, 8);
    centralHeader.writeUInt16LE(entry.method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.byteLength, 20);
    centralHeader.writeUInt32LE(data.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.byteLength + name.byteLength + compressed.byteLength + dataDescriptor.byteLength;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.byteLength, 12);
  endRecord.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}
