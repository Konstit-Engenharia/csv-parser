import iconv from 'iconv-lite';
import { bench } from 'mitata';
import {
  NativeCsvParser,
  parseCsvBuffer,
} from '../../src/index.ts';
import { makeLatin1Text } from './fixtures.ts';

export function registerSyntheticLatin1Benches(rows: number): void {
  const latin1 = iconv.encode(makeLatin1Text(rows), 'latin1');

  bench('native latin1 materialize rows(binary)', () => {
    const parsedRows = parseCsvBuffer(latin1, { encoding: 'latin1' });
    if (parsedRows.length !== rows + 1) {
      throw new Error(`bad row count: ${parsedRows.length}`);
    }
  });

  bench('native latin1 count', () => {
    using parser = new NativeCsvParser({ encoding: 'latin1' });
    const parsedRows = parser.writeCount(latin1, true);
    if (parsedRows !== rows + 1) {
      throw new Error(`bad row count: ${parsedRows}`);
    }
  });
}
