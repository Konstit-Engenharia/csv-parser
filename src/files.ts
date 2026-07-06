import { createReadStream } from 'node:fs';
import type {
  NativeCsvColumnStatsBatch,
  NativeCsvDictionaryBatch,
  NativeCsvGroupByCountBatch,
} from './batches.ts';
import {
  DEFAULT_CHUNK_SIZE,
  native,
} from './native.ts';
import { normalizeChunk } from './normalize.ts';
import { NativeCsvParser } from './parser.ts';
import {
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from './strict-schema.ts';
import type {
  CsvColumns,
  CsvFieldValue,
  CsvFileOptions,
  CsvNativeProjectionOptions,
  CsvParserOptions,
  CsvRow,
} from './types.ts';

export function parseCsvBuffer(buffer: NodeJS.TypedArray | DataView, options: CsvParserOptions = {}): CsvRow[] {
  const parser = new NativeCsvParser(options);
  const validator = strictSchemaValidator(options);
  try {
    const batch = parser.writeBatch(buffer, true);
    try {
      validator?.validateBatch(batch);
      validator?.finish();
      return batch.rowsInto([], options.selectedColumns);
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export function countTrustedNewlineRows(buffer: NodeJS.TypedArray | DataView): number {
  if (buffer.byteLength === 0) {
    return 0;
  }
  const input = normalizeChunk(buffer);
  return Number(native.symbols.csv_parser_count_trusted_newlines(input, BigInt(input.byteLength)));
}

export async function* parseCsvFile(path: string, options: CsvFileOptions = {}): AsyncGenerator<CsvRow[], void> {
  const parser = new NativeCsvParser(options);
  const validator = strictSchemaValidator(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        validator?.validateBatch(batch);
        const rows = batch.rowsInto([], options.selectedColumns);
        if (rows.length > 0) {
          yield rows;
        }
      } finally {
        batch.close();
      }
    }

    const batch = parser.endBatch();
    try {
      validator?.validateBatch(batch);
      validator?.finish();
      const rows = batch.rowsInto([], options.selectedColumns);
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function* parseCsvFileProjected(
  path: string,
  options: CsvFileOptions & CsvNativeProjectionOptions = {},
): AsyncGenerator<CsvRow[], void> {
  rejectStrictSchemaUnsupported(options, 'projected file parsing');
  const parser = new NativeCsvParser(options);
  const projectionOptions: CsvNativeProjectionOptions = {
    selectedColumns: options.selectedColumns,
    equalsFilter: options.equalsFilter,
  };
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = parser.writeProjectedBatch(chunk as Buffer, projectionOptions);
      try {
        const rows = batch.rows();
        if (rows.length > 0) {
          yield rows;
        }
      } finally {
        batch.close();
      }
    }

    const batch = parser.endProjectedBatch(projectionOptions);
    try {
      const rows = batch.rows();
      if (rows.length > 0) {
        yield rows;
      }
    } finally {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function* parseCsvFileDictionary(
  path: string,
  columnIndex: number,
  options: CsvFileOptions = {},
): AsyncGenerator<NativeCsvDictionaryBatch, void> {
  rejectStrictSchemaUnsupported(options, 'dictionary batches');
  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      const batch = parser.writeDictionaryBatch(chunk as Buffer, columnIndex);
      if (batch.rowCount > 0) {
        yield batch;
      } else {
        batch.close();
      }
    }

    const batch = parser.endDictionaryBatch(columnIndex);
    if (batch.rowCount > 0) {
      yield batch;
    } else {
      batch.close();
    }
  } finally {
    parser.close();
  }
}

export async function parseCsvFileGroupByCount(
  path: string,
  columnIndex: number,
  options: CsvFileOptions = {},
): Promise<NativeCsvGroupByCountBatch> {
  rejectStrictSchemaUnsupported(options, 'groupBy count');
  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeGroupByCount(chunk as Buffer, columnIndex);
    }
    return parser.endGroupByCount(columnIndex);
  } finally {
    parser.close();
  }
}

export async function parseCsvFileColumnStats(
  path: string,
  columnIndex: number,
  options: CsvFileOptions = {},
): Promise<NativeCsvColumnStatsBatch> {
  rejectStrictSchemaUnsupported(options, 'column stats');
  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeColumnStats(chunk as Buffer, columnIndex);
    }
    return parser.endColumnStats(columnIndex);
  } finally {
    parser.close();
  }
}

export async function parseCsvFileMultiColumnStats(
  path: string,
  columns: CsvColumns,
  options: CsvFileOptions = {},
): Promise<NativeCsvColumnStatsBatch[]> {
  rejectStrictSchemaUnsupported(options, 'multi-column stats');
  if (columns.length === 0) {
    return [];
  }

  const parser = new NativeCsvParser(options);
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      parser.writeMultiColumnStats(chunk as Buffer, columns);
    }
    return parser.endMultiColumnStats(columns);
  } finally {
    parser.close();
  }
}

export async function countCsvFile(path: string, options: CsvFileOptions = {}): Promise<number> {
  rejectStrictSchemaUnsupported(options, 'count');
  const parser = new NativeCsvParser(options);
  let rows = 0;
  try {
    if (options.strict === true) {
      for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
        const batch = parser.writeBatch(chunk as Buffer);
        try {
          rows += batch.rowCount;
        } finally {
          batch.close();
        }
      }
      const batch = parser.endBatch();
      try {
        rows += batch.rowCount;
      } finally {
        batch.close();
      }
      return rows;
    }

    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCount(chunk as Buffer);
    }
    rows += parser.endCount();
    return rows;
  } finally {
    parser.close();
  }
}

export async function countCsvFileWhereEquals(
  path: string,
  columnIndex: number,
  value: CsvFieldValue,
  options: CsvFileOptions = {},
): Promise<number> {
  rejectStrictSchemaUnsupported(options, 'count filters');
  const parser = new NativeCsvParser(options);
  const filter = { column: columnIndex, value };
  let rows = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCountWhereEquals(chunk as Buffer, filter);
    }
    rows += parser.endCountWhereEquals(filter);
    return rows;
  } finally {
    parser.close();
  }
}

export async function countCsvFileWhereIn(
  path: string,
  columnIndex: number,
  values: readonly CsvFieldValue[],
  options: CsvFileOptions = {},
): Promise<number> {
  rejectStrictSchemaUnsupported(options, 'count filters');
  if (values.length === 0) {
    return 0;
  }

  const parser = new NativeCsvParser(options);
  const filter = { column: columnIndex, values };
  let rows = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCountWhereIn(chunk as Buffer, filter);
    }
    rows += parser.endCountWhereIn(filter);
    return rows;
  } finally {
    parser.close();
  }
}

export async function countCsvFileWhereStartsWith(
  path: string,
  columnIndex: number,
  prefix: CsvFieldValue,
  options: CsvFileOptions = {},
): Promise<number> {
  rejectStrictSchemaUnsupported(options, 'count filters');
  const parser = new NativeCsvParser(options);
  const filter = { column: columnIndex, prefix };
  let rows = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: options.chunkSize ?? DEFAULT_CHUNK_SIZE })) {
      rows += parser.writeCountWhereStartsWith(chunk as Buffer, filter);
    }
    rows += parser.endCountWhereStartsWith(filter);
    return rows;
  } finally {
    parser.close();
  }
}
