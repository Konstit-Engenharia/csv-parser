import {
  type CsvParserOptions,
  type CsvRow,
  NativeCsvParser,
  parseCsvBuffer,
} from '../../src/index.ts';

export function parseRows(input: string | Buffer, options: CsvParserOptions = {}): CsvRow[] {
  return parseCsvBuffer(toBuffer(input), options);
}

export function parseChunkedRows(input: string | Buffer, chunkSize: number, options: CsvParserOptions = {}): CsvRow[] {
  const data = toBuffer(input);
  using parser = new NativeCsvParser(options);
  const rows: CsvRow[] = [];
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    using batch = parser.writeBatch(data.subarray(offset, offset + chunkSize));
    rows.push(...batch.rows());
  }

  using batch = parser.endBatch();
  rows.push(...batch.rows());
  return rows;
}

export function rowsToObjects(rows: CsvRow[]): Array<Record<string, string>> {
  const [headers, ...records] = rows;
  if (headers === undefined) {
    return [];
  }

  return records.map((row) => objectFromHeaders(headers, row));
}

export function rowsToGeneratedColumnObjects(rows: CsvRow[]): Array<Record<string, string>> {
  return rows.map((row) => {
    const object: Record<string, string> = {};
    for (let index = 0; index < row.length; ++index) {
      object[`_col.${index + 1}`] = row[index] ?? '';
    }
    return object;
  });
}

function objectFromHeaders(headers: CsvRow, row: CsvRow): Record<string, string> {
  const object: Record<string, string> = {};
  for (let index = 0; index < headers.length; ++index) {
    object[headers[index] ?? ''] = row[index] ?? '';
  }
  return object;
}

function toBuffer(input: string | Buffer): Buffer {
  return typeof input === 'string' ? Buffer.from(input) : input;
}
