import csvParser from 'csv-parser';
import iconv from 'iconv-lite';
import { heapStats } from 'bun:jsc';
import { createReadStream, statSync } from 'node:fs';
import {
  CsvStringCache,
  NativeCsvParser,
  countCsvFile,
  countCsvFileWhereEquals,
  parseCsvFile,
  parseCsvFileDictionary,
  parseCsvFileGroupByCount,
  parseCsvFileProjected,
} from '../src/index.ts';

type ProfileMode =
  | 'binary'
  | 'materialize'
  | 'materialize-reuse'
  | 'materialize-selected'
  | 'materialize-selected-cache'
  | 'materialize-selected-native'
  | 'dictionary-column'
  | 'groupby-count'
  | 'count'
  | 'filter-equals'
  | 'project-filter-equals-native'
  | 'csv-parser'
  | 'iconv-csv-parser';

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
const DICTIONARY_COLUMN = Number(Bun.env['CSV_BENCH_DICTIONARY_COLUMN'] ?? 19);
const GROUP_BY_COLUMN = Number(Bun.env['CSV_BENCH_GROUPBY_COLUMN'] ?? 19);
const bytes = statSync(FILE).size;

Bun.gc(true);
const before = heapStats();
const startedAt = performance.now();
const rows = await runMode(MODE);
Bun.gc(true);
const endedAt = performance.now();
const after = heapStats();
const seconds = (endedAt - startedAt) / 1000;

console.log(JSON.stringify({
  mode: MODE,
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  selectedColumns: SELECTED_COLUMNS,
  filterColumn: FILTER_COLUMN,
  filterValue: FILTER_VALUE,
  dictionaryColumn: DICTIONARY_COLUMN,
  groupByColumn: GROUP_BY_COLUMN,
  stringCacheColumns: STRING_CACHE_COLUMNS,
  rows,
  seconds,
  mibPerSecond: bytes / 1024 / 1024 / seconds,
  heapBefore: summarizeHeap(before),
  heapAfter: summarizeHeap(after),
}, null, 2));

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
    case 'dictionary-column':
      return countNativeDictionaryColumn();
    case 'groupby-count':
      return countNativeGroupByCount();
    case 'count':
      return countCsvFile(FILE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER });
    case 'filter-equals':
      return countCsvFileWhereEquals(FILE, FILTER_COLUMN, FILTER_VALUE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER });
    case 'project-filter-equals-native':
      return countNativeProjectedFilteredRows();
    case 'csv-parser':
      return countWithCsvParser();
    case 'iconv-csv-parser':
      return countWithCsvParser('latin1');
  }
}

async function countNativeGroupByCount(): Promise<number> {
  const batch = await parseCsvFileGroupByCount(FILE, GROUP_BY_COLUMN, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
  });
  try {
    batch.counts();
    batch.dictionaryOffsets();
    batch.dictionaryData();
    if (batch.dictionaryCount === 0) {
      throw new Error('groupby-count produced no dictionary values');
    }
    return batch.rowCount;
  } finally {
    batch.close();
  }
}

async function countNativeDictionaryColumn(): Promise<number> {
  let rows = 0;
  let dictionaryValues = 0;
  for await (const batch of parseCsvFileDictionary(FILE, DICTIONARY_COLUMN, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
  })) {
    try {
      rows += batch.rowCount;
      batch.ids();
      batch.dictionaryOffsets();
      batch.dictionaryData();
      dictionaryValues += batch.dictionaryStrings().length;
    } finally {
      batch.close();
    }
  }
  if (dictionaryValues === 0) {
    throw new Error('dictionary-column produced no dictionary values');
  }
  return rows;
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
  for await (const batch of parseCsvFileProjected(FILE, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    selectedColumns: SELECTED_COLUMNS,
  })) {
    rows += batch.length;
  }
  return rows;
}

async function countNativeProjectedFilteredRows(): Promise<number> {
  let rows = 0;
  for await (const batch of parseCsvFileProjected(FILE, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
    selectedColumns: SELECTED_COLUMNS,
    equalsFilter: {
      column: FILTER_COLUMN,
      value: FILTER_VALUE,
    },
  })) {
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

function countWithCsvParser(encoding?: 'latin1'): Promise<number> {
  return new Promise((resolve, reject) => {
    let rows = 0;
    let stream = createReadStream(FILE, { highWaterMark: CHUNK_SIZE });

    if (encoding !== undefined) {
      stream = stream.pipe(iconv.decodeStream(encoding)) as unknown as typeof stream;
    }

    stream
      .pipe(csvParser({ headers: false, separator: DELIMITER }))
      .on('data', () => {
        ++rows;
      })
      .on('error', reject)
      .on('end', () => {
        resolve(rows);
      });
  });
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
