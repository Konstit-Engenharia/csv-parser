import { bench } from 'mitata';
import {
  NativeCsvParser,
  parseCsvBuffer,
} from '../../src/index.ts';
import { makeUtf8Fixture } from './fixtures.ts';

export function registerSyntheticUtf8Benches(rows: number): void {
  const utf8 = makeUtf8Fixture(rows);

  bench('native utf8 materialize rows(binary)', () => {
    const parsedRows = parseCsvBuffer(utf8, { encoding: 'utf8' });
    if (parsedRows.length !== rows + 1) {
      throw new Error(`bad row count: ${parsedRows.length}`);
    }
  });

  bench('native utf8 count', () => {
    using parser = new NativeCsvParser({ encoding: 'utf8' });
    const parsedRows = parser.writeCount(utf8, true);
    if (parsedRows !== rows + 1) {
      throw new Error(`bad row count: ${parsedRows}`);
    }
  });
}
