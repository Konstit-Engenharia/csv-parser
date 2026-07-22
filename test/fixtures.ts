import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const corpusRoot = join(import.meta.dir, '..', 'corpus');

export function csvFixturePath(relativePath: string): string {
  return join(corpusRoot, relativePath);
}

export function readCsvFixture(relativePath: string): Buffer {
  return readFileSync(csvFixturePath(relativePath));
}
