import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { csvFixturePath } from './fixtures.ts';
import { createZip } from './zip-fixture.ts';

const cliPath = join(import.meta.dir, '..', 'src', 'cli.ts');
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'csv-cli-'));
  await Bun.write(
    join(temporaryDirectory, 'input.csv.gz'),
    Bun.gzipSync(Buffer.from('id;name\n1;Ada\n2;Bob\n')),
  );
  await Bun.write(
    join(temporaryDirectory, 'input.zip'),
    createZip([{ data: Buffer.from('id;name\n1;Ada\n2;Bob\n'), method: 8, name: 'nested/input.csv' }]),
  );
  await Bun.write(
    join(temporaryDirectory, 'high-ratio.zip'),
    createZip([{ data: Buffer.from('a;b\n'.repeat(4_096)), method: 8, name: 'input.csv' }]),
  );
  await Bun.write(join(temporaryDirectory, 'empty.csv'), '');
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe('csv CLI', () => {
  test('counts every record in a CSV file', () => {
    const result = runCli('count', csvFixturePath('rfc4180/simple-lf.csv'));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports delimiter and chunk size options', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/unquoted-people-sp-filter.csv'),
      '--delimiter',
      ';',
      '--chunk-size',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('4\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports automatic delimiter detection', () => {
    const result = runCli('count', csvFixturePath('api/unquoted-people-sp-filter.csv'), '--delimiter', 'auto');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('4\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports compression options', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'input.csv.gz'),
      '--chunk-size',
      '2',
      '--compression',
      'auto',
      '--delimiter',
      ';',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('3\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports ZIP entry and safety options', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'input.zip'),
      '--compression',
      'zip',
      '--zip-entry',
      'nested/input.csv',
      '--max-compression-ratio',
      '100',
      '--max-decompressed-bytes',
      '1024',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('3\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('forwards the ZIP decompressed byte limit', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'input.zip'),
      '--compression',
      'zip',
      '--zip-entry',
      'nested/input.csv',
      '--max-decompressed-bytes',
      '1',
    );

    expectCommandError(result, 'maximum decompressed byte count');
  });

  test('forwards the ZIP compression ratio limit', () => {
    const result = runCli(
      'count',
      join(temporaryDirectory, 'high-ratio.zip'),
      '--compression',
      'zip',
      '--zip-entry',
      'input.csv',
      '--max-compression-ratio',
      '1',
    );

    expectCommandError(result, 'maximum compression ratio');
  });

  test('supports latin1 encoding', () => {
    const result = runCli(
      'count',
      csvFixturePath('native/latin1-names.csv'),
      '--delimiter',
      ';',
      '--encoding',
      'latin1',
      '--where',
      JSON.stringify({ column: 1, equals: 'João' }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('1\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports strict validation and a fixed column count', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--fixed-columns',
      '3',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('supports strict schema count options', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--chunk-size',
      '1',
      '--expected-header',
      'id',
      '--expected-header',
      'name',
      '--expected-header',
      'uf',
      '--require-header',
      '--min-data-rows',
      '1',
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe('2\n');
    expect(result.stderr.toString()).toBe('');
  });

  test('reports an expected header mismatch', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--expected-header',
      'wrong',
      '--expected-header',
      'name',
      '--expected-header',
      'uf',
    );

    expectCommandError(result, 'strict CSV schema error: header mismatch at column 0');
  });

  test('reports a missing required header', () => {
    const result = runCli('count', join(temporaryDirectory, 'empty.csv'), '--strict', '--require-header');

    expectCommandError(result, 'strict CSV schema error: missing header row');
  });

  test('reports an insufficient data row count', () => {
    const result = runCli(
      'count',
      csvFixturePath('api/strict-schema-valid.csv'),
      '--delimiter',
      ';',
      '--strict',
      '--min-data-rows',
      '2',
    );

    expectCommandError(result, 'strict CSV schema error: expected at least 2 data row(s), got 1');
  });

  for (const option of ['--columns', '--selected-columns']) {
    test(`accepts ${option} for Count API parity`, () => {
      const result = runCli('count', csvFixturePath('rfc4180/simple-lf.csv'), option, '0');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe('2\n');
      expect(result.stderr.toString()).toBe('');
    });
  }

  test('reports strict syntax errors', () => {
    const result = runCli(
      'count',
      csvFixturePath('rfc4180-invalid/unescaped-quote-in-unquoted-field.csv'),
      '--strict',
    );

    expectCommandError(result, 'strict CSV quote syntax error: unescaped quote in unquoted field');
  });

  test('reports fixed column count mismatches', () => {
    const result = runCli(
      'count',
      csvFixturePath('native/fixed-column-mismatch.csv'),
      '--strict',
      '--fixed-columns',
      '3',
    );

    expectCommandError(result, 'fixed row column count mismatch');
  });

  const filterCases = [
    {
      expected: '2\n',
      filter: { column: 2, equals: 'SP' },
      name: 'equals',
    },
    {
      expected: '3\n',
      filter: { column: 2, in: ['SP', 'RJ'] },
      name: 'in',
    },
    {
      expected: '1\n',
      filter: { column: 1, startsWith: 'B' },
      name: 'startsWith',
    },
    {
      expected: '2\n',
      filter: { column: 2, regex: { flags: 'i', source: '^sp$' } },
      name: 'regex',
    },
    {
      expected: '1\n',
      filter: {
        all: [
          { column: 2, in: ['SP', 'RJ'] },
          { column: 1, startsWith: 'B' },
          { column: 0, equals: '3' },
        ],
      },
      name: 'AND',
    },
  ] as const;

  for (const { expected, filter, name } of filterCases) {
    test(`supports a ${name} filter`, () => {
      const result = runCli(
        'count',
        csvFixturePath('api/unquoted-people-sp-filter.csv'),
        '--delimiter',
        ';',
        '--where',
        JSON.stringify(filter),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(expected);
      expect(result.stderr.toString()).toBe('');
    });
  }

  test('shows command help', () => {
    const result = runCli('--help');

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('count <path>');
    expect(result.stdout.toString()).toContain('bunx @konstit/csv count <path>');
    expect(result.stderr.toString()).toBe('');
  });

  test('shows every count option in count help', () => {
    const result = runCli('count', '--help');
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain('Usage: csv count <path> [options]');
    for (
      const option of [
        '--delimiter',
        '--encoding',
        '--chunk-size',
        '--compression',
        '--zip-entry',
        '--max-compression-ratio',
        '--max-decompressed-bytes',
        '--strict',
        '--fixed-columns',
        '--columns',
        '--selected-columns',
        '--expected-header',
        '--require-header',
        '--min-data-rows',
        '--where',
      ]
    ) {
      expect(stdout).toContain(option);
    }
    expect(stdout).toContain('"regex":{"source":"^A","flags":"i"}');
    expect(stdout).toContain('Strict mode cannot use --where.');
    expect(stdout).not.toContain('--worker-count');
    expect(result.stderr.toString()).toBe('');
  });

  test('reports invalid usage without a stack trace', () => {
    const result = runCli('count');

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toBe('csv: count requires one file path\nRun \'csv count --help\' for usage.\n');
  });

  const invalidOptionCases: readonly {
    arguments: readonly string[];
    message: string;
    name: string;
  }[] = [
    {
      arguments: ['--delimiter', '||'],
      message: 'delimiter must be one safe ASCII character or auto',
      name: 'a multi-character delimiter',
    },
    {
      arguments: ['--delimiter', '"'],
      message: 'delimiter must be one safe ASCII character or auto',
      name: 'a structural quote delimiter',
    },
    {
      arguments: ['--encoding', 'utf16'],
      message: 'unsupported encoding: utf16',
      name: 'an unsupported encoding',
    },
    {
      arguments: ['--chunk-size', '0'],
      message: 'chunk size must be an integer from 1 through 67108864',
      name: 'a zero chunk size',
    },
    {
      arguments: ['--chunk-size', '67108865'],
      message: 'chunk size must be an integer from 1 through 67108864',
      name: 'an excessive chunk size',
    },
    {
      arguments: ['--fixed-columns', '0'],
      message: 'fixed columns must be an integer greater than or equal to 1',
      name: 'a zero fixed column count',
    },
    {
      arguments: ['--worker-count', '2'],
      message: 'Unknown option \'--worker-count\'',
      name: 'the removed worker count option',
    },
    {
      arguments: ['--compression', 'unknown'],
      message: 'unsupported compression format: unknown',
      name: 'an unsupported compression format',
    },
    {
      arguments: ['--compression', 'zip'],
      message: '--compression zip requires --zip-entry <path>',
      name: 'ZIP input without an entry',
    },
    {
      arguments: ['--compression', 'zip', '--zip-entry', 'data.csv', '--max-compression-ratio', '1.5'],
      message: 'maximum compression ratio must be an integer from 1 through 4294967295',
      name: 'a fractional ZIP compression ratio',
    },
    {
      arguments: ['--where', '{'],
      message: '--where must be valid JSON',
      name: 'invalid filter JSON',
    },
    {
      arguments: ['--where', '[]'],
      message: '--where must be a JSON object',
      name: 'a non-object filter',
    },
    {
      arguments: ['--where', '{"all":[]}'],
      message: '--where.all must be a non-empty array',
      name: 'an empty AND filter',
    },
    {
      arguments: ['--where', '{"column":2,"in":[]}'],
      message: '--where.in must be a non-empty string array',
      name: 'an empty in filter',
    },
    {
      arguments: ['--where', '{"column":2,"equals":"SP","extra":true}'],
      message: '--where contains unknown property: extra',
      name: 'an unknown filter property',
    },
    {
      arguments: ['--where', '{"column":2,"equals":1}'],
      message: '--where.equals must be a string',
      name: 'a non-string filter value',
    },
    {
      arguments: ['--where', '{"equals":"SP"}'],
      message: '--where.column must be a number',
      name: 'a missing filter column',
    },
    {
      arguments: ['--where', '{"column":2025,"equals":"SP"}'],
      message: 'filter column out of range: 2025',
      name: 'an excessive filter column',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"flags":"i"}}'],
      message: '--where.regex.source must be a string',
      name: 'a regex without a source',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"source":"["}}'],
      message: 'Invalid regular expression',
      name: 'invalid JavaScript regex syntax',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"source":"SP","flags":"g"}}'],
      message: 'unsupported regular expression flags: g',
      name: 'unsupported regex flags',
    },
    {
      arguments: ['--where', '{"column":2,"regex":{"source":"(?=SP)"}}'],
      message: 'invalid regular expression: invalid perl operator',
      name: 'an RE2-incompatible regex',
    },
    {
      arguments: [
        '--where',
        JSON.stringify({
          all: Array.from({ length: 33 }, () => ({ column: 2, regex: { source: 'SP' } })),
        }),
      ],
      message: 'regex filter count out of range: 33',
      name: 'too many regex filters',
    },
    {
      arguments: [
        '--where',
        JSON.stringify({
          all: Array.from({ length: 2025 }, () => ({ column: 2, equals: 'SP' })),
        }),
      ],
      message: 'filter count out of range: 2025',
      name: 'too many filters',
    },
    {
      arguments: ['--columns', '2025'],
      message: 'selected column out of range: 2025',
      name: 'an excessive selected column',
    },
  ];

  for (const invalidCase of invalidOptionCases) {
    test(`rejects ${invalidCase.name}`, () => {
      const result = runCli(
        'count',
        csvFixturePath('api/unquoted-people-sp-filter.csv'),
        ...invalidCase.arguments,
      );

      expectUsageError(result, invalidCase.message);
    });
  }

  const incompatibleOptionCases: readonly {
    arguments: readonly string[];
    message: string;
    name: string;
  }[] = [
    {
      arguments: ['--columns', '0', '--selected-columns', '1'],
      message: 'use --columns or --selected-columns, not both',
      name: 'both column option aliases',
    },
    {
      arguments: ['--fixed-columns', '3'],
      message: '--fixed-columns requires --strict',
      name: 'fixed columns without strict mode',
    },
    {
      arguments: ['--expected-header', 'id'],
      message: '--expected-header, --require-header, and --min-data-rows require --strict',
      name: 'strict schema options without strict mode',
    },
    {
      arguments: ['--strict', '--where', '{"column":2,"equals":"SP"}'],
      message: '--strict cannot be combined with --where',
      name: 'strict mode and filtering',
    },
  ];

  for (const incompatibleCase of incompatibleOptionCases) {
    test(`rejects ${incompatibleCase.name}`, () => {
      const result = runCli(
        'count',
        csvFixturePath('api/unquoted-people-sp-filter.csv'),
        ...incompatibleCase.arguments,
      );

      expectUsageError(result, incompatibleCase.message);
    });
  }

  test('reports file errors without a stack trace', () => {
    const missingPath = join(import.meta.dir, 'missing-cli-input.csv');
    const result = runCli('count', missingPath);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe('');
    expect(result.stderr.toString()).toContain('csv: ');
    expect(result.stderr.toString()).toContain('missing-cli-input.csv');
    expect(result.stderr.toString()).not.toContain('\n    at ');
  });
});

function runCli(...arguments_: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliPath, ...arguments_],
    stderr: 'pipe',
    stdout: 'pipe',
  });
}

function expectUsageError(result: ReturnType<typeof runCli>, message: string): void {
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toContain(`csv: ${message}`);
  expect(result.stderr.toString()).toContain('Run \'csv count --help\' for usage.');
  expect(result.stderr.toString()).not.toContain('\n    at ');
}

function expectCommandError(result: ReturnType<typeof runCli>, message: string): void {
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe('');
  expect(result.stderr.toString()).toStartWith('csv: ');
  expect(result.stderr.toString()).toContain(message);
  expect(result.stderr.toString()).not.toContain('\n    at ');
}
