import csvParser from 'csv-parser';
import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../src/index.ts';

const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'example.csv';
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const LIMIT = Number(Bun.env['CSV_PRINT_ROWS'] ?? 10);

console.log('native materialize rows(reused js arrays)');
for (const row of await readNativeRows()) {
  console.log(row);
}

console.log('csv-parser');
for (const row of await readCsvParserRows()) {
  console.log(row);
}

async function readNativeRows(): Promise<string[][]> {
  const parser = new NativeCsvParser({ delimiter: DELIMITER });
  const rowsBuffer: string[][] = [];
  const output: string[][] = [];
  try {
    for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
      const batch = parser.writeBatch(chunk as Buffer);
      try {
        for (const row of batch.rowsInto(rowsBuffer)) {
          output.push([...row]);
          if (output.length >= LIMIT) {
            return output;
          }
        }
      } finally {
        batch.close();
      }
    }

    const batch = parser.endBatch();
    try {
      for (const row of batch.rowsInto(rowsBuffer)) {
        output.push([...row]);
        if (output.length >= LIMIT) {
          return output;
        }
      }
    } finally {
      batch.close();
    }
    return output;
  } finally {
    parser.close();
  }
}

function readCsvParserRows(): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const output: Record<string, string>[] = [];
    const stream = createReadStream(FILE, { highWaterMark: CHUNK_SIZE })
      .pipe(csvParser({ headers: false, separator: DELIMITER }))
      .on('data', (row: Record<string, string>) => {
        output.push(row);
        if (output.length >= LIMIT) {
          stream.destroy();
        }
      })
      .on('error', reject)
      .on('close', () => {
        resolve(output);
      })
      .on('end', () => {
        resolve(output);
      });
  });
}
