import { csv } from '../src/index.ts';
import {
  CHUNK_SIZE,
  DELIMITER,
  FILE,
} from './config.ts';

const WORKERS = Number(Bun.env['CSV_WORKERS'] ?? 4);

using pool = csv
  .file(FILE)
  .delimiter(DELIMITER)
  .chunkSize(CHUNK_SIZE)
  .workers(WORKERS)
  .pool();

console.log(await pool.count());
console.log(await pool.count());
