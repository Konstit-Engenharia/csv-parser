import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  findVersionBump,
  normalizeRegistry,
  parsePushUpdates,
} from '../scripts/pre-push.ts';

const LOCAL_OBJECT = '1'.repeat(40);
const REMOTE_OBJECT = '2'.repeat(40);
const OTHER_LOCAL_OBJECT = '3'.repeat(40);
const ZERO_OBJECT = '0'.repeat(40);

describe('pre-push package publication', () => {
  test('parses git push updates', () => {
    expect(parsePushUpdates(`refs/heads/main ${LOCAL_OBJECT} refs/heads/main ${REMOTE_OBJECT}\n`)).toEqual([{
      localObject: LOCAL_OBJECT,
      localRef: 'refs/heads/main',
      remoteObject: REMOTE_OBJECT,
      remoteRef: 'refs/heads/main',
    }]);
    expect(() => parsePushUpdates('invalid')).toThrow('invalid git pre-push input');
  });

  test('finds one increased package version and skips non-updates', async () => {
    const versions = new Map([
      [LOCAL_OBJECT, '1.1.0'],
      [REMOTE_OBJECT, '1.0.0'],
    ]);
    const readVersion = (object: string): Promise<string | undefined> => Promise.resolve(versions.get(object));

    expect(
      await findVersionBump(
        parsePushUpdates(
          `refs/heads/main ${LOCAL_OBJECT} refs/heads/main ${REMOTE_OBJECT}\n`,
        ),
        readVersion,
      ),
    ).toEqual({ localObject: LOCAL_OBJECT, version: '1.1.0' });
    expect(
      await findVersionBump(
        parsePushUpdates(
          `refs/heads/new ${LOCAL_OBJECT} refs/heads/new ${ZERO_OBJECT}\n`,
        ),
        readVersion,
      ),
    ).toBeUndefined();
    expect(
      await findVersionBump(
        parsePushUpdates(
          `refs/heads/main ${ZERO_OBJECT} refs/heads/main ${REMOTE_OBJECT}\n`,
        ),
        readVersion,
      ),
    ).toBeUndefined();
  });

  test('does not publish equal or decreased versions', async () => {
    const update = parsePushUpdates(`refs/heads/main ${LOCAL_OBJECT} refs/heads/main ${REMOTE_OBJECT}\n`);

    expect(await findVersionBump(update, (object) => Promise.resolve(object === LOCAL_OBJECT ? '1.0.0' : '1.0.0')))
      .toBeUndefined();
    expect(await findVersionBump(update, (object) => Promise.resolve(object === LOCAL_OBJECT ? '0.9.0' : '1.0.0')))
      .toBeUndefined();
  });

  test('rejects multiple version bumps in one push', async () => {
    const updates = parsePushUpdates(
      `refs/heads/main ${LOCAL_OBJECT} refs/heads/main ${REMOTE_OBJECT}\nrefs/heads/next ${OTHER_LOCAL_OBJECT} refs/heads/next ${REMOTE_OBJECT}\n`,
    );
    const versions = new Map([
      [LOCAL_OBJECT, '1.1.0'],
      [OTHER_LOCAL_OBJECT, '2.0.0'],
      [REMOTE_OBJECT, '1.0.0'],
    ]);

    expect(findVersionBump(updates, (object) => Promise.resolve(versions.get(object))))
      .rejects.toThrow('push contains multiple package version bumps');
  });

  test('validates and normalizes registry URLs', () => {
    expect(normalizeRegistry(undefined)).toBeUndefined();
    expect(normalizeRegistry('  ')).toBeUndefined();
    expect(normalizeRegistry('https://registry.example.com/npm')).toBe('https://registry.example.com/npm');
    expect(normalizeRegistry('http://localhost:4873')).toBe('http://localhost:4873/');
    expect(() => normalizeRegistry('http://registry.example.com')).toThrow('must use HTTPS');
    expect(() => normalizeRegistry('https://user:secret@registry.example.com')).toThrow('must not contain credentials');
    expect(() => normalizeRegistry('not a URL')).toThrow('must be a valid URL');
  });
});
