import {
  describe,
  expect,
  test,
} from 'bun:test';
import {
  gitOutput,
  isObject,
  main,
  readPackageVersion,
  readPackageVersionAt,
  requireSafePublishState,
  run,
} from '../scripts/pre-push.ts';
import {
  defineColumnarOptions,
  defineCountOptions,
  defineRowsOptions,
  defineRowViewOptions,
} from '../src/options.ts';
import {
  CsvStrictSchemaValidator,
  rejectStrictSchemaUnsupported,
  strictSchemaValidator,
} from '../src/strict-schema.ts';

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  if (!(caught instanceof Error)) {
    throw new Error('expected operation to reject');
  }
  return caught;
}

describe('option identity helpers', () => {
  test('preserve each options object', () => {
    const rows = defineRowsOptions({ delimiter: ';' });
    const count = defineCountOptions({ strict: true });
    const columnar = defineColumnarOptions({ columns: [0] as const });
    const views = defineRowViewOptions({ columns: [0] as const });
    expect(rows.delimiter).toBe(';');
    expect(count.strict).toBe(true);
    expect(columnar.columns).toEqual([0]);
    expect(views.columns).toEqual([0]);
  });
});

describe('strict schema validation', () => {
  test('validates rows, headers, minimum rows, and disabled mode', () => {
    const validator = new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'], minDataRows: 1 });
    expect(validator.enabled).toBe(true);
    validator.validateRows([['a', 'b'], ['1', '2']]);
    expect(() => validator.finish()).not.toThrow();
    expect(strictSchemaValidator({ strict: false })).toBeUndefined();
    expect(strictSchemaValidator({ strict: true })).toBeUndefined();
    expect(() => rejectStrictSchemaUnsupported({ strict: true, requireHeader: true }, 'count')).toThrow('not supported');
  });

  test('rejects missing, malformed, and mismatched schemas', () => {
    expect(() => new CsvStrictSchemaValidator({ requireHeader: true }).finish()).toThrow('missing header');
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a'] }).validateRows([['a', 'b']])).toThrow('header field');
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a'] }).validateRows([['b']])).toThrow('header mismatch');
    const tooFew = new CsvStrictSchemaValidator({ minDataRows: 2 });
    tooFew.validateRows([['a'], ['1']]);
    expect(() => tooFew.finish()).toThrow('at least');
    expect(() => new CsvStrictSchemaValidator({ minDataRows: -1 })).toThrow('non-negative integer');
  });

  test('validates native batch headers and data rows', () => {
    const batchData = {
      rowCount: 2,
      rowFieldCount: (row: number) => row === 0 ? 2 : 1,
      fieldString: (row: number, column: number) => row === 0 ? (column === 0 ? 'a' : 'b') : '1',
    };
    const batch = batchData as unknown as import('../src/batches.ts').NativeCsvBatch;
    const validator = new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'] });
    validator.validateBatch(batch);
    expect(() => validator.finish()).not.toThrow();
    const wrongLength = { ...batchData, rowCount: 1, rowFieldCount: () => 1 } as unknown as import('../src/batches.ts').NativeCsvBatch;
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'] }).validateBatch(wrongLength)).toThrow('header field');
    const wrongValue = { ...batchData, rowCount: 1, fieldString: () => 'x' } as unknown as import('../src/batches.ts').NativeCsvBatch;
    expect(() => new CsvStrictSchemaValidator({ expectedHeaders: ['a', 'b'] }).validateBatch(wrongValue)).toThrow('header mismatch');
  });
});

describe('pre-push helpers', () => {
  test('reads versions and validates manifests', async () => {
    expect(isObject({})).toBe(true);
    expect(isObject([])).toBe(false);
    expect(readPackageVersion({ version: '1.2.3' })).toBe('1.2.3');
    expect(() => readPackageVersion({})).toThrow('version string');
    expect(() => readPackageVersion({ version: 'bad' })).toThrow('invalid semantic');
    expect(await readPackageVersionAt('HEAD')).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    expect((await rejectedError(readPackageVersionAt('0'.repeat(40)))).message).toContain('unavailable');
  });

  test('runs commands and reports failures', async () => {
    await run(['true'], 'success');
    expect((await rejectedError(run(['false'], 'checks'))).message).toContain('checks failed');
    expect(await gitOutput(['rev-parse', '--is-inside-work-tree'])).toBe('true');
    expect((await rejectedError(gitOutput(['definitely-not-a-git-command']))).message).toContain('failed with exit code');
    const version = readPackageVersion(await Bun.file('package.json').json());
    expect((await rejectedError(requireSafePublishState({ localObject: 'not-head', version }))).message).toContain(
      'other than HEAD',
    );
    const head = await gitOutput(['rev-parse', 'HEAD']);
    const otherVersion = version === '0.0.0' ? '0.0.1' : '0.0.0';
    expect((await rejectedError(requireSafePublishState({ localObject: head, version: otherVersion }))).message).toContain(
      'working-tree package version',
    );
    expect(
      (await rejectedError(
        requireSafePublishState({ localObject: head, version }, async (args) => args[0] === 'rev-parse' ? head : 'dirty'),
      )).message,
    ).toContain('dirty worktree');
    const fakeSpawn = ((options: { cmd: string[]; }) =>
      options.cmd[1] === 'show'
        ? { success: false, exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('') }
        : { success: true, exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') }) as unknown as typeof Bun.spawnSync;
    expect(await readPackageVersionAt('known', fakeSpawn)).toBeUndefined();
    const invalidJsonSpawn =
      (() => ({ success: true, exitCode: 0, stdout: Buffer.from('{'), stderr: Buffer.from('') })) as unknown as typeof Bun.spawnSync;
    expect((await rejectedError(readPackageVersionAt('bad-json', invalidJsonSpawn))).message).toContain('invalid at git object');
  });

  test('runs pre-push checks and optional publication through injected boundaries', async () => {
    const commands: string[][] = [];
    const runStub = async (command: string[]): Promise<void> => {
      commands.push(command);
    };
    await main({ input: Promise.resolve(''), registry: '', run: runStub });
    expect(commands).toHaveLength(1);
    commands.length = 0;
    await main({
      input: Promise.resolve(`refs/heads/main ${'1'.repeat(40)} refs/heads/main ${'2'.repeat(40)}`),
      registry: 'https://registry.example.com',
      readVersion: async (object) => object === '1'.repeat(40) ? '1.1.0' : '1.0.0',
      requireSafe: async () => {},
      run: runStub,
    });
    expect(commands).toHaveLength(2);
    expect((await rejectedError(main({ input: Promise.resolve('refs/main bad refs/main bad'), registry: '' }))).message).toContain(
      'object ID',
    );
  });
});
