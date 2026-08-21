import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import { DEFAULT_CHUNK_SIZE } from './native.ts';
import type { CsvFileOptions } from './types.ts';

interface CompressionExtensionHint {
  extension: string;
  format: Bun.CompressionFormat;
  signatureRequired: boolean;
}

export function readCsvFileChunks(
  path: string,
  options: Pick<CsvFileOptions, 'chunkSize' | 'compression'>,
): AsyncIterable<Uint8Array> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (options.compression === undefined) {
    return createReadStream(path, { highWaterMark: chunkSize });
  }
  if (options.compression === 'auto') {
    return readAutoDetectedCsvFileChunks(path, chunkSize);
  }
  return decompressedCsvFileChunks(path, options.compression, chunkSize);
}

export function rejectCompressedSharding(
  options: Pick<CsvFileOptions, 'compression'>,
  operation: string,
): void {
  if (options.compression !== undefined) {
    throw new Error(`${operation} does not support compressed input because compressed byte offsets cannot be sharded`);
  }
}

async function* readAutoDetectedCsvFileChunks(path: string, chunkSize: number): AsyncGenerator<Uint8Array, void> {
  const compression = await detectCompression(path);
  for await (const chunk of decompressedCsvFileChunks(path, compression, chunkSize)) {
    yield chunk;
  }
}

function decompressedCsvFileChunks(
  path: string,
  compression: Bun.CompressionFormat,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  return Bun.file(path).stream().pipeThrough(
    new DecompressionStream(compression, { highWaterMark: chunkSize }),
  );
}

async function detectCompression(path: string): Promise<Bun.CompressionFormat> {
  const prefix = await Bun.file(path).slice(0, 4).bytes();
  const extensionHint = compressionFromExtension(path);
  const strongSignature = compressionFromStrongSignature(prefix);

  if (strongSignature !== undefined) {
    if (extensionHint !== undefined && extensionHint.format !== strongSignature) {
      throw new Error(
        `compression auto-detection mismatch: extension ${extensionHint.extension} indicates ${extensionHint.format}, but the file signature indicates ${strongSignature}`,
      );
    }
    return strongSignature;
  }

  const hasZlibHeader = isZlibHeader(prefix);
  if (extensionHint !== undefined) {
    if (extensionHint.signatureRequired) {
      if (extensionHint.format === 'deflate' && hasZlibHeader) {
        return 'deflate';
      }
      if (extensionHint.extension === '.deflate') {
        throw new Error(
          'compression auto-detection is ambiguous for .deflate input; specify compression: \'deflate-raw\' when the stream has no zlib wrapper',
        );
      }
      throw new Error(
        `compression auto-detection failed: extension ${extensionHint.extension} does not match the file signature`,
      );
    }
    return extensionHint.format;
  }

  if (hasZlibHeader) {
    return 'deflate';
  }

  throw new Error(
    'compression auto-detection failed: no supported signature or extension; specify compression as \'brotli\' or \'deflate-raw\' when applicable',
  );
}

function compressionFromExtension(path: string): CompressionExtensionHint | undefined {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.deflate-raw')) {
    return { extension: '.deflate-raw', format: 'deflate-raw', signatureRequired: false };
  }

  const extension = extname(lowerPath);
  switch (extension) {
    case '.br':
      return { extension, format: 'brotli', signatureRequired: false };
    case '.deflate':
    case '.zlib':
    case '.zz':
      return { extension, format: 'deflate', signatureRequired: true };
    case '.gz':
    case '.gzip':
      return { extension, format: 'gzip', signatureRequired: true };
    case '.zst':
    case '.zstd':
      return { extension, format: 'zstd', signatureRequired: true };
    default:
      return undefined;
  }
}

function compressionFromStrongSignature(prefix: Uint8Array): Bun.CompressionFormat | undefined {
  if (prefix[0] === 0x1f && prefix[1] === 0x8b) {
    return 'gzip';
  }
  if (prefix[0] === 0x28 && prefix[1] === 0xb5 && prefix[2] === 0x2f && prefix[3] === 0xfd) {
    return 'zstd';
  }
  if (
    prefix[0] !== undefined && prefix[0] >= 0x50 && prefix[0] <= 0x5f && prefix[1] === 0x2a
    && prefix[2] === 0x4d && prefix[3] === 0x18
  ) {
    return 'zstd';
  }
  return undefined;
}

function isZlibHeader(prefix: Uint8Array): boolean {
  const compressionMethodAndFlags = prefix[0];
  const flags = prefix[1];
  if (compressionMethodAndFlags === undefined || flags === undefined) {
    return false;
  }
  return (compressionMethodAndFlags & 0x0f) === 8
    && (compressionMethodAndFlags >> 4) <= 7
    && ((compressionMethodAndFlags << 8) | flags) % 31 === 0;
}
