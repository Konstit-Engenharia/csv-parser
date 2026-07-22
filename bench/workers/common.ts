import {
  createReadStream,
  statSync,
} from 'node:fs';
import {
  type FileHandle,
  open,
} from 'node:fs/promises';
import { NativeCsvParser } from '../../src/index.ts';
import {
  native,
  requirePtr,
  toArrayBuffer,
  u64ToSafeNumber,
} from '../../src/native.ts';

export interface TrustedShard {
  start: number;
  end: number;
}

export interface TrustedWorkerOptions {
  chunkSize: number;
  delimiter: string;
  fixedColumns: number;
  path: string;
  shard: TrustedShard;
  onBatchRows?: (rows: number) => void;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;
const ALIGN_SCAN_BYTES = 64 * 1024;

export function fileSize(path: string): number {
  return statSync(path).size;
}

export async function inferFixedColumns(path: string, delimiter: string): Promise<number> {
  const file = Bun.file(path);
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let line = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const text = decoder.decode(value, { stream: true });
      const newline = text.indexOf('\n');
      if (newline >= 0) {
        line += text.slice(0, newline).replace(/\r$/, '');
        break;
      }
      line += text;
    }
  } finally {
    reader.releaseLock();
  }

  return countCsvColumns(line, delimiter);
}

export async function buildNewlineAlignedShards(path: string, shardCount: number): Promise<TrustedShard[]> {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new RangeError(`invalid shard count: ${shardCount}`);
  }

  const size = fileSize(path);
  if (size === 0) {
    return [];
  }

  const starts = [0];
  await using file = await open(path, 'r');
  for (let shardIndex = 1; shardIndex < shardCount; ++shardIndex) {
    const target = Math.floor((size * shardIndex) / shardCount);
    const start = await findNextLineStart(file, target, size);
    if (start > (starts.at(-1) ?? 0)) {
      starts.push(start);
    }
  }

  starts.push(size);

  return startsToShards(starts);
}

export async function buildCsvSafeShards(
  path: string,
  shardCount: number,
  delimiter: string,
): Promise<TrustedShard[]> {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new RangeError(`invalid shard count: ${shardCount}`);
  }
  if (delimiter.length !== 1) {
    throw new Error('delimiter must be one character');
  }

  const size = fileSize(path);
  if (size === 0) {
    return [];
  }

  const starts = [0];
  const targets = Array.from({ length: shardCount - 1 }, (_, index) => Math.floor((size * (index + 1)) / shardCount));
  const delimiterByte = delimiter.charCodeAt(0);
  let targetIndex = 0;
  let byteOffset = 0;
  let inQuotes = false;
  let atFieldStart = true;
  let pendingQuote = false;

  for await (const chunk of createReadStream(path, { highWaterMark: 8 * 1024 * 1024 })) {
    const bytes = chunk as Buffer;
    let index = 0;

    while (index < bytes.byteLength && targetIndex < targets.length) {
      const byte = bytes[index];
      if (byte === undefined) {
        throw new Error(`missing byte ${String(index)} while scanning ${path}`);
      }
      const absolute = byteOffset + index;

      if (pendingQuote) {
        if (byte === QUOTE) {
          pendingQuote = false;
          ++index;
          continue;
        }
        pendingQuote = false;
        inQuotes = false;
      }

      if (inQuotes) {
        if (byte === QUOTE) {
          if (index + 1 < bytes.byteLength) {
            if (bytes[index + 1] === QUOTE) {
              index += 2;
              continue;
            }
            inQuotes = false;
            ++index;
            continue;
          }
          pendingQuote = true;
          ++index;
          continue;
        }
        ++index;
        continue;
      }

      if (atFieldStart && byte === QUOTE) {
        inQuotes = true;
        atFieldStart = false;
        ++index;
        continue;
      }

      if (byte === delimiterByte) {
        atFieldStart = true;
      } else if (byte === NEWLINE) {
        atFieldStart = true;
        while (targetIndex < targets.length) {
          const target = targets[targetIndex];
          if (target === undefined || absolute + 1 < target) {
            break;
          }
          starts.push(absolute + 1);
          ++targetIndex;
        }
      } else if (byte !== CARRIAGE_RETURN) {
        atFieldStart = false;
      }

      ++index;
    }

    byteOffset += bytes.byteLength;
    if (targetIndex >= targets.length) {
      break;
    }
  }

  starts.push(size);
  return startsToShards(starts);
}

export function buildNativeCsvSafeShards(
  path: string,
  shardCount: number,
  delimiter: string,
): TrustedShard[] {
  if (!Number.isInteger(shardCount) || shardCount <= 0) {
    throw new RangeError(`invalid shard count: ${shardCount}`);
  }
  if (delimiter.length !== 1) {
    throw new Error('delimiter must be one character');
  }
  const size = fileSize(path);

  const batch = native.symbols.csv_parser_find_split_offsets(
    Buffer.from(`${path}\0`),
    BigInt(shardCount),
    delimiter.charCodeAt(0),
  );
  if (batch === null) {
    throw new Error(`native split offset scan failed for ${path}`);
  }

  try {
    const count = u64ToSafeNumber(native.symbols.csv_split_offsets_batch_count(batch), 'CSV split offset count');
    if (count === 0) {
      return [];
    }
    const ptr = native.symbols.csv_split_offsets_batch_ptr(batch);
    const offsets = new BigUint64Array(toArrayBuffer(requirePtr(ptr), 0, count * BigUint64Array.BYTES_PER_ELEMENT));
    const starts: number[] = [];
    starts.length = offsets.length;
    for (let index = 0; index < offsets.length; ++index) {
      const offset = u64ToSafeNumber(offsets[index] ?? 0n, 'CSV split offset');
      if (offset > size) {
        throw new RangeError(`CSV split offset exceeds file size: ${offset}`);
      }
      starts[index] = offset;
    }
    return startsToShards(starts);
  } finally {
    native.symbols.csv_split_offsets_batch_destroy(batch);
  }
}

export async function countTrustedShardRows(options: TrustedWorkerOptions): Promise<number> {
  using parser = new NativeCsvParser({
    delimiter: options.delimiter,
    trusted: {
      fixedColumns: options.fixedColumns,
      noNewlinesInQuotes: true,
    },
  });
  let rows = 0;
  for await (
    const chunk of createReadStream(options.path, {
      start: options.shard.start,
      end: options.shard.end,
      highWaterMark: options.chunkSize,
    })
  ) {
    using batch = parser.writeBatch(chunk as Buffer);
    rows += batch.rowCount;
    options.onBatchRows?.(batch.rowCount);
  }

  using batch = parser.endBatch();
  rows += batch.rowCount;
  if (batch.rowCount > 0) {
    options.onBatchRows?.(batch.rowCount);
  }
  return rows;
}

async function findNextLineStart(file: FileHandle, offset: number, size: number): Promise<number> {
  if (offset <= 0) {
    return 0;
  }
  if (offset >= size) {
    return size;
  }

  const buffer = Buffer.allocUnsafe(ALIGN_SCAN_BYTES);
  let cursor = offset;
  while (cursor < size) {
    const remaining = size - cursor;
    const bytesToRead = Math.min(buffer.byteLength, remaining);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, cursor);
    if (bytesRead === 0) {
      return size;
    }
    const newlineIndex = buffer.subarray(0, bytesRead).indexOf(NEWLINE);
    if (newlineIndex >= 0) {
      return cursor + newlineIndex + 1;
    }
    cursor += bytesRead;
  }
  return size;
}

function startsToShards(starts: number[]): TrustedShard[] {
  const shards: TrustedShard[] = [];
  for (let index = 0; index < starts.length - 1; ++index) {
    const start = starts[index];
    const nextStart = starts[index + 1];
    if (start === undefined || nextStart === undefined) {
      throw new Error(`missing shard boundary at index ${String(index)}`);
    }
    if (nextStart <= start) {
      continue;
    }
    shards.push({
      start,
      end: nextStart - 1,
    });
  }
  return shards;
}

function countCsvColumns(row: string, delimiter: string): number {
  if (row.length === 0) {
    return 0;
  }
  let columns = 1;
  let inQuotes = false;
  for (let index = 0; index < row.length; ++index) {
    const char = row[index];
    if (char === '"') {
      if (inQuotes && row[index + 1] === '"') {
        ++index;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && char === delimiter) {
      ++columns;
    }
  }
  return columns;
}
