import { heapStats } from 'bun:jsc';
import {
  createReadStream,
  statSync,
} from 'node:fs';
import {
  countCsvFile,
  countCsvFileWhereEquals,
  CsvStringCache,
  NativeCsvParser,
  parseCsvFile,
  parseCsvFileProjected,
} from '../src/index.ts';

type ProfileMode =
  | 'binary'
  | 'materialize'
  | 'materialize-reuse'
  | 'materialize-selected'
  | 'materialize-selected-cache'
  | 'materialize-selected-native'
  | 'count'
  | 'filter-equals'
  | 'project-filter-equals-native';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const MODE = (Bun.env['CSV_PROFILE_MODE'] ?? Bun.argv[2] ?? 'materialize-reuse') as ProfileMode;
const SELECTED_COLUMNS = (Bun.env['CSV_BENCH_COLUMNS'] ?? '0,4,19')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);
const STRING_CACHE_COLUMNS = (Bun.env['CSV_STRING_CACHE_COLUMNS'] ?? '19')
  .split(',')
  .filter((value) => value.trim() !== '')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);
const FILTER_COLUMN = Number(Bun.env['CSV_BENCH_FILTER_COLUMN'] ?? 19);
const FILTER_VALUE = Bun.env['CSV_BENCH_FILTER_VALUE'] ?? 'SP';
const bytes = statSync(FILE).size;

Bun.gc(true);
const before = heapStats();
const startedAt = performance.now();
const rows = await runMode(MODE);
Bun.gc(true);
const endedAt = performance.now();
const after = heapStats();
const seconds = (endedAt - startedAt) / 1000;

console.log(JSON.stringify(
  {
    mode: MODE,
    file: FILE,
    bytes,
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    selectedColumns: SELECTED_COLUMNS,
    filterColumn: FILTER_COLUMN,
    filterValue: FILTER_VALUE,
    stringCacheColumns: STRING_CACHE_COLUMNS,
    rows,
    seconds,
    mibPerSecond: bytes / 1024 / 1024 / seconds,
    heapBefore: summarizeHeap(before),
    heapAfter: summarizeHeap(after),
  },
  null,
  2,
));

async function runMode(mode: ProfileMode): Promise<number> {
  switch (mode) {
    case 'binary':
      return countNativeBatchRows();
    case 'materialize':
      return countNativeMaterializedRows();
    case 'materialize-reuse':
      return countNativeMaterializedRowsReused();
    case 'materialize-selected':
      return countNativeSelectedRows();
    case 'materialize-selected-cache':
      return countNativeSelectedRowsCached();
    case 'materialize-selected-native':
      return countNativeProjectedRows();
    case 'count':
      return countCsvFile(FILE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER });
    case 'filter-equals':
      return countCsvFileWhereEquals(FILE, FILTER_COLUMN, FILTER_VALUE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER });
    case 'project-filter-equals-native':
      return countNativeProjectedFilteredRows();
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

async function countNativeProjectedFilteredRows(): Promise<number> {
  let rows = 0;
  for await (
    const batch of parseCsvFileProjected(FILE, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
      selectedColumns: SELECTED_COLUMNS,
      equalsFilter: {
        column: FILTER_COLUMN,
        value: FILTER_VALUE,
      },
    })
  ) {
    rows += batch.length;
  }
  return rows;
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

function summarizeHeap(stats: ReturnType<typeof heapStats>) {
  return {
    heapSize: stats.heapSize,
    heapCapacity: stats.heapCapacity,
    extraMemorySize: stats.extraMemorySize,
    objectCount: stats.objectCount,
    arrayCount: stats.objectTypeCounts['Array'] ?? 0,
    stringCount: stats.objectTypeCounts['string'] ?? 0,
    objectTypeCount: stats.objectTypeCounts['Object'] ?? 0,
  };
}
