import {
  parseCsvFileDictionary,
  parseCsvFileGroupByCount,
} from '../../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  DICTIONARY_COLUMN,
  type ExampleBenchCase,
  FILE,
  GROUP_BY_COLUMN,
} from './config.ts';

export const aggregateCases = [
  ['native dictionary column ids', () => countNativeDictionaryColumn()],
  ['native groupby count', () => countNativeGroupByCount()],
] as const satisfies readonly ExampleBenchCase[];

async function countNativeDictionaryColumn(): Promise<number> {
  let rows = 0;
  let dictionaryValues = 0;
  for await (
    const batch of parseCsvFileDictionary(FILE, DICTIONARY_COLUMN, {
      chunkSize: CHUNK_SIZE,
      delimiter: DELIMITER,
    })
  ) {
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
