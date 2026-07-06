import { createReadStream } from 'node:fs';
import {
  CsvStringCache,
  NativeCsvParser,
  parseCsvFile,
  parseCsvFileProjected,
} from '../../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  type ExampleBenchCase,
  FILE,
  SELECTED_COLUMNS,
  STRING_CACHE_COLUMNS,
} from './config.ts';

export const materializationCases = [
  ['native binary batches', () => countNativeBatchRows()],
  ['native materialize rows(binary batches)', () => countNativeMaterializedRows()],
  ['native materialize rows(reused js arrays)', () => countNativeMaterializedRowsReused()],
  ['native materialize selected columns', () => countNativeSelectedRows()],
  ['native materialize selected columns(cached strings)', () => countNativeSelectedRowsCached()],
  ['native projected columns', () => countNativeProjectedRows()],
] as const satisfies readonly ExampleBenchCase[];

async function countNativeBatchRows(): Promise<number> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  let rows = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
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
  } finally {
    parser.close();
  }
}

async function countNativeMaterializedRows(): Promise<number> {
  let rows = 0;
  for await (const batch of parseCsvFile(FILE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER })) {
    rows += batch.length;
  }
  return rows;
}

async function countNativeMaterializedRowsReused(): Promise<number> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        rows += batch.rowsInto(rowsBuffer).length;
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      rows += batch.rowsInto(rowsBuffer).length;
    } finally {
      batch.close();
    }
    return rows;
  } finally {
    parser.close();
  }
}

async function countNativeSelectedRows(): Promise<number> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  let rows = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        rows += batch.rowsInto(rowsBuffer, SELECTED_COLUMNS).length;
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      rows += batch.rowsInto(rowsBuffer, SELECTED_COLUMNS).length;
    } finally {
      batch.close();
    }
    return rows;
  } finally {
    parser.close();
  }
}

async function countNativeSelectedRowsCached(): Promise<number> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  const stringCache = new CsvStringCache({ columns: STRING_CACHE_COLUMNS });
  let rows = 0;
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        rows += batch.rowsInto(rowsBuffer, SELECTED_COLUMNS, stringCache).length;
      } finally {
        batch.close();
      }
    }
    const batch = parser.endBatch();
    try {
      rows += batch.rowsInto(rowsBuffer, SELECTED_COLUMNS, stringCache).length;
    } finally {
      batch.close();
    }
    return rows;
  } finally {
    parser.close();
  }
}

async function countNativeProjectedRows(): Promise<number> {
  let rows = 0;
  for await (
    const batch of parseCsvFileProjected(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      selectedColumns: SELECTED_COLUMNS,
    })
  ) {
    rows += batch.length;
  }
  return rows;
}
