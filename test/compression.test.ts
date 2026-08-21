import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
} from 'node:zlib';
import {
  countCsvFile,
  countCsvFileWhereEquals,
  countCsvFileWhereIn,
  countCsvFileWhereStartsWith,
  csv,
  type CsvCountOptions,
  type CsvParallelCountOptions,
  type CsvParallelRowsOptions,
  type CsvRowsOptions,
  type CsvShardingOptions,
  type CsvWorkerPoolOptions,
  parallelCount,
  parallelRows,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';

const source = Buffer.from('id;name;state\n1;"Ana\nMaria";SP\n2;Bia;RJ\n3;Caio;SP\n');
const expectedRows = [
  ['id', 'name', 'state'],
  ['1', 'Ana\nMaria', 'SP'],
  ['2', 'Bia', 'RJ'],
  ['3', 'Caio', 'SP'],
];
const formats = ['gzip', 'deflate', 'deflate-raw', 'brotli', 'zstd'] as const satisfies readonly Bun.CompressionFormat[];

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'csv-parser-compression-'));
  await Promise.all(
    formats.map((format) => Bun.write(compressedPath(format), compress(source, format))),
  );
  await Bun.write(join(temporaryDirectory, 'corrupt.csv.gz'), compress(source, 'gzip').subarray(0, 8));
  await Bun.write(join(temporaryDirectory, 'signature-only'), compress(source, 'gzip'));
  await Bun.write(join(temporaryDirectory, 'mismatch.br'), compress(source, 'gzip'));
  await Bun.write(join(temporaryDirectory, 'ambiguous.deflate'), compress(source, 'deflate-raw'));
  await Bun.write(join(temporaryDirectory, 'plain.csv.gz'), source);
  await Bun.write(join(temporaryDirectory, 'plain.tsv'), source);
  await Bun.write(
    join(temporaryDirectory, 'input.zip'),
    createZip([
      { data: Buffer.from('ignored'), method: 0, name: 'README.txt' },
      { data: source, dataDescriptor: true, method: 8, name: 'nested/input.tsv' },
    ]),
  );
  await Bun.write(
    join(temporaryDirectory, 'stored.zip'),
    createZip([{ data: source, method: 0, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'corrupt.zip'),
    createZip([{ crc32: (crc32(source) ^ 1) >>> 0, data: source, method: 8, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'duplicate.zip'),
    createZip([
      { data: source, method: 8, name: 'input.tsv' },
      { data: source, method: 8, name: 'input.tsv' },
    ]),
  );
  await Bun.write(
    join(temporaryDirectory, 'encrypted.zip'),
    createZip([{ data: source, flags: 1, method: 8, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'unsupported.zip'),
    createZip([{ data: source, method: 99, name: 'input.tsv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'high-ratio.zip'),
    createZip([{ data: Buffer.from('a;b\n'.repeat(4_096)), method: 8, name: 'input.tsv' }]),
  );
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('compressed CSV file streams', () => {
  test('streams every Bun compression format through rows and count', async () => {
    for (const compression of formats) {
      const rows: string[][] = [];
      for await (
        const batch of csv.rows(compressedPath(compression), {
          chunkSize: 11,
          compression,
          delimiter: ';',
        })
      ) {
        rows.push(...batch);
      }

      expect(rows).toEqual(expectedRows);
      expect(await csv.count(compressedPath(compression), { chunkSize: 13, compression, delimiter: ';' })).toBe(4);
    }
  });

  test('auto-detects every supported compression format', async () => {
    for (const format of formats) {
      const rows: string[][] = [];
      for await (
        const batch of csv.rows(compressedPath(format), {
          chunkSize: 11,
          compression: 'auto',
          delimiter: ';',
        })
      ) {
        rows.push(...batch);
      }
      expect(rows).toEqual(expectedRows);
    }
  });

  test('auto-detects strong signatures without a file extension', async () => {
    expect(
      await csv.count(join(temporaryDirectory, 'signature-only'), {
        compression: 'auto',
        delimiter: ';',
      }),
    ).toBe(4);
  });

  test('rejects extension mismatches and ambiguous input', async () => {
    const mismatch = await rejectedError(
      csv.count(join(temporaryDirectory, 'mismatch.br'), { compression: 'auto', delimiter: ';' }),
    );
    expect(mismatch.message).toContain('extension .br indicates brotli, but the file signature indicates gzip');

    const ambiguous = await rejectedError(
      csv.count(join(temporaryDirectory, 'ambiguous.deflate'), { compression: 'auto', delimiter: ';' }),
    );
    expect(ambiguous.message).toContain('auto-detection is ambiguous for .deflate input');

    const invalidGzip = await rejectedError(
      csv.count(join(temporaryDirectory, 'plain.csv.gz'), { compression: 'auto', delimiter: ';' }),
    );
    expect(invalidGzip.message).toContain('extension .gz does not match the file signature');

    const unknown = await rejectedError(
      csv.count(join(temporaryDirectory, 'plain.tsv'), { compression: 'auto', delimiter: ';' }),
    );
    expect(unknown.message).toContain('no supported signature or extension');
  });

  test('streams compressed input through batch and callback APIs', async () => {
    const path = compressedPath('gzip');
    const batchRows: string[][] = [];
    for await (using batch of csv.batches(path, { chunkSize: 9, compression: 'gzip', delimiter: ';' })) {
      batchRows.push(...batch.rows());
    }

    const columnarRows: string[] = [];
    await csv.withColumnarBatches(
      path,
      { chunkSize: 7, columns: [0, 2] as const, compression: 'gzip', delimiter: ';' },
      (batch) => {
        for (let rowIndex = 0; rowIndex < batch.rowCount; ++rowIndex) {
          columnarRows.push(
            `${batch.fieldBuffer(rowIndex, 0)?.toString()}|${batch.fieldBuffer(rowIndex, 1)?.toString()}`,
          );
        }
      },
    );

    expect(batchRows).toEqual(expectedRows);
    expect(columnarRows).toEqual(['id|state', '1|SP', '2|RJ', '3|SP']);
  });

  test('supports compressed input through the direct file helpers', async () => {
    const path = compressedPath('gzip');
    const rows: string[][] = [];
    for await (const batch of parseCsvFile(path, { chunkSize: 9, compression: 'gzip', delimiter: ';' })) {
      rows.push(...batch);
    }

    const projectedRows: string[][] = [];
    for await (
      const batch of parseCsvFileProjected(path, {
        chunkSize: 7,
        compression: 'gzip',
        delimiter: ';',
        selectedColumns: [0, 2],
      })
    ) {
      projectedRows.push(...batch);
    }

    expect(rows).toEqual(expectedRows);
    expect(projectedRows).toEqual([
      ['id', 'state'],
      ['1', 'SP'],
      ['2', 'RJ'],
      ['3', 'SP'],
    ]);
    expect(await countCsvFile(path, { compression: 'gzip', delimiter: ';' })).toBe(4);
    expect(await countCsvFileWhereEquals(path, 2, 'SP', { compression: 'gzip', delimiter: ';' })).toBe(2);
    expect(await countCsvFileWhereIn(path, 2, ['SP', 'RJ'], { compression: 'gzip', delimiter: ';' })).toBe(3);
    expect(await countCsvFileWhereStartsWith(path, 1, 'B', { compression: 'gzip', delimiter: ';' })).toBe(1);
  });

  test('propagates decompression errors', async () => {
    const error = await rejectedError(
      csv.count(join(temporaryDirectory, 'corrupt.csv.gz'), { compression: 'gzip', delimiter: ';' }),
    );
    expect(error.message.length).toBeGreaterThan(0);
  });

  test('streams a selected deflated ZIP entry through serial APIs', async () => {
    const compression = { entry: 'nested/input.tsv', format: 'zip' } as const;
    const rows: string[][] = [];
    for await (
      const batch of csv.rows(join(temporaryDirectory, 'input.zip'), {
        chunkSize: 5,
        compression,
        delimiter: 'auto',
      })
    ) {
      rows.push(...batch);
    }

    expect(rows).toEqual(expectedRows);
    expect(
      await csv.count(join(temporaryDirectory, 'input.zip'), {
        chunkSize: 7,
        compression,
        delimiter: ';',
      }),
    ).toBe(4);
  });

  test('streams a stored ZIP entry', async () => {
    expect(
      await csv.count(join(temporaryDirectory, 'stored.zip'), {
        chunkSize: 3,
        compression: { entry: 'input.tsv', format: 'zip' },
        delimiter: ';',
      }),
    ).toBe(4);
  });

  test('rejects invalid ZIP archives and configured limits', async () => {
    const options = (entry = 'input.tsv') => ({
      compression: { entry, format: 'zip' } as const,
      delimiter: ';' as const,
    });

    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'input.zip'), options('missing.tsv')))).message,
    ).toContain('requested ZIP entry was not found');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'corrupt.zip'), options()))).message,
    ).toContain('CRC32 check failed');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'duplicate.zip'), options()))).message,
    ).toContain('duplicate entries');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'encrypted.zip'), options()))).message,
    ).toContain('encrypted ZIP entries are not supported');
    expect(
      (await rejectedError(csv.count(join(temporaryDirectory, 'unsupported.zip'), options()))).message,
    ).toContain('compression method is not supported');
    expect(
      (
        await rejectedError(
          csv.count(join(temporaryDirectory, 'stored.zip'), {
            compression: { entry: 'input.tsv', format: 'zip', maxDecompressedBytes: source.byteLength - 1 },
            delimiter: ';',
          }),
        )
      ).message,
    ).toContain('maximum decompressed byte count');
    expect(
      (
        await rejectedError(
          csv.count(join(temporaryDirectory, 'high-ratio.zip'), {
            compression: { entry: 'input.tsv', format: 'zip', maxCompressionRatio: 2 },
            delimiter: ';',
          }),
        )
      ).message,
    ).toContain('maximum compression ratio');
  });

  test('rejects compression for the in-memory parse API at runtime', async () => {
    const options = { compression: 'gzip' } as unknown as Parameters<typeof csv.parse>[1];
    expect((await rejectedError(csv.parse(source, options))).message).toContain('parse() does not support compression');
  });

  test('rejects compressed input for byte-offset worker and shard APIs', async () => {
    const invalidRows = { compression: 'gzip', workerCount: 2 } as unknown as CsvRowsOptions;
    const invalidCount = { compression: 'gzip', workerCount: 2 } as unknown as CsvCountOptions;
    const invalidPool = { compression: 'gzip', workerCount: 2 } as unknown as CsvWorkerPoolOptions;
    const invalidSharding = { compression: 'gzip' } as unknown as CsvShardingOptions;

    const rowsError = await rejectedAsyncGeneratorError(csv.rows('unused.csv.gz', invalidRows));
    expect(rowsError.message).toContain('parallel row parsing does not support compressed input');
    expect((await rejectedError(csv.count('unused.csv.gz', invalidCount))).message).toContain(
      'parallel counting does not support compressed input',
    );
    expect(() => csv.workerPool('unused.csv.gz', invalidPool)).toThrow('worker pool does not support compressed input');
    expect(() => csv.findCsvSafeSplitOffsets('unused.csv.gz', 2, invalidSharding)).toThrow(
      'CSV split offset scanning does not support compressed input',
    );

    const directRowsError = await rejectedAsyncGeneratorError(
      parallelRows('unused.csv.gz', invalidRows as unknown as CsvParallelRowsOptions),
    );
    expect(directRowsError.message).toContain('parallel row parsing does not support compressed input');
    expect(
      (await rejectedError(parallelCount('unused.csv.gz', invalidCount as unknown as CsvParallelCountOptions))).message,
    ).toContain(
      'parallel counting does not support compressed input',
    );
  });
});

function compressedPath(format: Bun.CompressionFormat): string {
  const extensionByFormat = {
    'brotli': 'br',
    'deflate': 'zlib',
    'deflate-raw': 'deflate-raw',
    'gzip': 'gz',
    'zstd': 'zst',
  } satisfies Record<Bun.CompressionFormat, string>;
  return join(temporaryDirectory, `input.tsv.${extensionByFormat[format]}`);
}

function compress(input: Uint8Array<ArrayBuffer>, format: Bun.CompressionFormat): Uint8Array {
  switch (format) {
    case 'brotli':
      return brotliCompressSync(input);
    case 'deflate':
      return deflateSync(input);
    case 'deflate-raw':
      return deflateRawSync(input);
    case 'gzip':
      return Bun.gzipSync(input);
    case 'zstd':
      return Bun.zstdCompressSync(input);
  }
}

interface TestZipEntry {
  crc32?: number;
  data: Uint8Array;
  dataDescriptor?: boolean;
  flags?: number;
  method: 0 | 8 | 99;
  name: string;
}

function createZip(entries: readonly TestZipEntry[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const compressed = entry.method === 8 ? deflateRawSync(data) : data;
    const checksum = entry.crc32 ?? crc32(data);
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

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; ++bit) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected promise to reject');
}

async function rejectedAsyncGeneratorError(generator: AsyncGenerator<unknown, void>): Promise<Error> {
  try {
    await generator.next();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('expected async generator to reject');
}
