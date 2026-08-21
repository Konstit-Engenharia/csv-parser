import csvParser from 'csv-parser';
import { createReadStream } from 'node:fs';
import { NativeCsvParser } from '../src/index.ts';

/**
 * Compare the low-level native streaming API with the `csv-parser` package.
 *
 * This example intentionally drives `NativeCsvParser` directly. Most callers
 * should prefer `csv.rows()`, which manages file reads, parser finalization,
 * and native batch cleanup automatically.
 */
const FILE = Bun.env['CSV_BENCH_FILE'] ?? 'corpus/large/example.csv';
// The stream chunk size controls I/O granularity. Neither parser assumes that a
// chunk ends at a CSV record boundary.
const CHUNK_SIZE = Number(Bun.env['CSV_BENCH_CHUNK_SIZE'] ?? 8 * 1024 * 1024);
const DELIMITER = Bun.env['CSV_BENCH_DELIMITER'] ?? ';';
const LIMIT = Number(Bun.env['CSV_PRINT_ROWS'] ?? 10);

// Native rows are arrays because no header-mapping step is requested here.
console.log('native materialize rows(reused js arrays)');
for (const row of await readNativeRows()) {
  console.log(row);
}

// `headers: false` gives the comparison parser numeric string keys rather than
// treating the first record as a header row.
console.log('csv-parser');
for (const row of await readCsvParserRows()) {
  console.log(row);
}

async function readNativeRows(): Promise<string[][]> {
  // The parser keeps incomplete quoted records between `writeBatch()` calls,
  // which is why arbitrary stream chunks are safe to pass directly.
  using parser = new NativeCsvParser({ delimiter: DELIMITER });

  // `rowsInto()` reuses both this outer array and its existing row arrays across
  // batches. Reuse avoids allocating a fresh array shape for every native batch.
  const rowsBuffer: string[][] = [];
  const output: string[][] = [];
  for await (const chunk of createReadStream(FILE, { highWaterMark: CHUNK_SIZE })) {
    // `writeBatch()` emits only complete records currently available. The
    // parser retains any partial trailing record for the next call.
    using batch = parser.writeBatch(chunk as Buffer);
    for (const row of batch.rowsInto(rowsBuffer)) {
      // Copy before retaining: the next `rowsInto()` call may overwrite this
      // reused row array in place.
      output.push([...row]);
      if (output.length >= LIMIT) {
        return output;
      }
    }
  }

  // Finalization flushes a last record even when the file does not end with a
  // newline and reports any error that is only knowable at end-of-input.
  using batch = parser.endBatch();
  for (const row of batch.rowsInto(rowsBuffer)) {
    // The final batch uses the same reusable row storage as regular batches.
    output.push([...row]);
    if (output.length >= LIMIT) {
      return output;
    }
  }
  return output;
}

function readCsvParserRows(): Promise<Record<string, string>[]> {
  // Adapt the event-emitter interface to a Promise so both implementations can
  // be awaited by the same top-level printing code.
  return new Promise((resolve, reject) => {
    const output: Record<string, string>[] = [];
    const stream = createReadStream(FILE, { highWaterMark: CHUNK_SIZE })
      .pipe(csvParser({ headers: false, separator: DELIMITER }))
      .on('data', (row: Record<string, string>) => {
        output.push(row);
        if (output.length >= LIMIT) {
          // Destroying the pipeline stops additional file reads. The resulting
          // `close` event resolves with the rows already collected.
          stream.destroy();
        }
      })
      .on('error', reject)
      .on('close', () => {
        // Early destruction completes through `close` rather than `end`.
        resolve(output);
      })
      .on('end', () => {
        // Natural EOF completes through `end`. Promise settlement is idempotent
        // if the stream implementation subsequently also emits `close`.
        resolve(output);
      });
  });
}
