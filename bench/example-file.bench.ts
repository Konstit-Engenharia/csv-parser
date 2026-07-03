import csvParser from 'csv-parser';
import iconv from 'iconv-lite';
import { measure } from 'mitata';
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

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
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

const cases = [
  ['native binary batches', () => countNativeBatchRows()],
  ['native materialize rows(binary batches)', () => countNativeMaterializedRows()],
  ['native materialize rows(reused js arrays)', () => countNativeMaterializedRowsReused()],
  ['native materialize selected columns', () => countNativeSelectedRows()],
  ['native materialize selected columns(cached strings)', () => countNativeSelectedRowsCached()],
  ['native dictionary column ids', () => countNativeDictionaryColumn()],
  ['native groupby count', () => countNativeGroupByCount()],
  ['native projected columns', () => countNativeProjectedRows()],
  ['native count', () => countCsvFile(FILE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER })],
  ['native filter equals', () => countCsvFileWhereEquals(FILE, FILTER_COLUMN, FILTER_VALUE, {
    chunkSize: CHUNK_SIZE,
    delimiter: DELIMITER,
  })],
  ['native projected filter equals', () => countNativeProjectedFilteredRows()],
  ['csv-parser utf8', () => countWithCsvParser()],
  ['iconv-lite latin1 + csv-parser', () => countWithCsvParser('latin1')],
] as const;

console.log(JSON.stringify({
  file: FILE,
  bytes,
  chunkSize: CHUNK_SIZE,
  delimiter: DELIMITER,
  selectedColumns: SELECTED_COLUMNS,
  stringCacheColumns: STRING_CACHE_COLUMNS,
  filterColumn: FILTER_COLUMN,
  filterValue: FILTER_VALUE,
  dictionaryColumn: DICTIONARY_COLUMN,
  groupByColumn: GROUP_BY_COLUMN,
}));

for (const [name, fn] of cases) {
  let rows = 0;
  const stats = await measure(async () => {
    rows = await fn();
    if (rows === 0) {
      throw new Error(`${name}: zero rows`);
    }
  }, {
    min_samples: 1,
    max_samples: 1,
    min_cpu_time: 0,
    warmup_samples: 0,
  });

  const seconds = stats.avg / 1e9;
  const mibPerSecond = bytes / 1024 / 1024 / seconds;

  console.log(JSON.stringify({
    name,
    rows,
    seconds,
    mibPerSecond,
  }));
}

async function countNativeMaterializedRows(): Promise<number> {
  let rows = 0;
  for await (const batch of parseCsvFile(FILE, { chunkSize: CHUNK_SIZE, delimiter: DELIMITER })) {
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
    throw new Error('native dictionary column ids: no dictionary values');
  }
  return rows;
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
      throw new Error('native groupby count: no dictionary values');
    }
    return batch.rowCount;
  } finally {
    batch.close();
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
