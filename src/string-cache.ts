import type {
  CsvStringCacheColumnStats,
  CsvStringCacheOptions,
} from './types.ts';

interface StringCacheEntry {
  bytes: Buffer;
  value: string;
}

interface StringCacheColumn {
  buckets: Map<number, StringCacheEntry[]>;
  entries: number;
  hits: number;
  misses: number;
  full: boolean;
}

export class CsvStringCache {
  readonly #columns: Set<number> | undefined;
  readonly #maxEntriesPerColumn: number;
  readonly #caches = new Map<number, StringCacheColumn>();

  constructor(options: CsvStringCacheOptions = {}) {
    this.#columns = options.columns === undefined ? undefined : new Set(options.columns);
    this.#maxEntriesPerColumn = options.maxEntriesPerColumn ?? 4096;
  }

  decode(data: Buffer, start: number, end: number, column: number): string {
    if (start === end) {
      return '';
    }
    if (this.#columns !== undefined && !this.#columns.has(column)) {
      return data.toString('utf8', start, end);
    }

    const cache = this.#cacheFor(column);
    const hash = hashBytes(data, start, end);
    const bucket = cache.buckets.get(hash);
    if (bucket !== undefined) {
      for (const entry of bucket) {
        if (bytesEqual(data, start, end, entry.bytes)) {
          ++cache.hits;
          return entry.value;
        }
      }
    }

    ++cache.misses;
    const value = data.toString('utf8', start, end);
    if (!cache.full) {
      const entry = {
        bytes: Buffer.from(data.subarray(start, end)),
        value,
      };
      if (bucket === undefined) {
        cache.buckets.set(hash, [entry]);
      } else {
        bucket.push(entry);
      }
      ++cache.entries;
      cache.full = cache.entries >= this.#maxEntriesPerColumn;
    }
    return value;
  }

  stats(): CsvStringCacheColumnStats[] {
    return [...this.#caches.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([column, cache,]) => ({
        column,
        entries: cache.entries,
        hits: cache.hits,
        misses: cache.misses,
        full: cache.full,
      }));
  }

  clear(): void {
    this.#caches.clear();
  }

  #cacheFor(column: number): StringCacheColumn {
    const existing = this.#caches.get(column);
    if (existing !== undefined) {
      return existing;
    }

    const created = {
      buckets: new Map<number, StringCacheEntry[]>(),
      entries: 0,
      hits: 0,
      misses: 0,
      full: false,
    };
    this.#caches.set(column, created);
    return created;
  }
}

function hashBytes(data: Buffer, start: number, end: number): number {
  let hash = 0x811c9dc5;
  for (let index = start; index < end; ++index) {
    hash ^= data[index] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
function bytesEqual(data: Buffer, start: number, end: number, expected: Buffer): boolean {
  const len = end - start;
  if (expected.byteLength !== len) {
    return false;
  }
  for (let index = 0; index < len; ++index) {
    if (data[start + index] !== expected[index]) {
      return false;
    }
  }
  return true;
}
