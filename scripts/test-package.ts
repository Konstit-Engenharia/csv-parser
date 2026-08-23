// Installs a package tarball in a temporary project and smoke-tests its native CSV parser.
import {
  mkdtemp,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';

const tarball = process.argv[2];
if (tarball === undefined) {
  throw new Error('usage: bun scripts/test-package.ts <package.tgz>');
}

const directory = await mkdtemp(join(tmpdir(), 'konstit-csv-parser-package-'));
try {
  await Bun.write(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  run(['bun', 'add', resolve(tarball)], directory);
  run([
    'bun',
    '-e',
    'import { csv } from \'@konstit/csv\'; const rows = await csv.parse(Buffer.from(\'id,name\\n1,Ada\\n\')); if (rows.length !== 2 || rows[1]?.[1] !== \'Ada\') throw new Error(\'package smoke test failed\');',
  ], directory);
  console.log('package import and native parse smoke passed');

  const csvPath = join(directory, 'input.csv');
  await Bun.write(csvPath, 'id;name\n1;Ada\n2;Bob\n');
  const cliResult = Bun.spawnSync({
    cmd: [
      'bunx',
      '@konstit/csv',
      'count',
      csvPath,
      '--chunk-size',
      '2',
      '--delimiter',
      ';',
      '--where-prefix',
      '1=A',
    ],
    cwd: directory,
    stderr: 'inherit',
    stdout: 'pipe',
  });
  if (!cliResult.success || cliResult.stdout.toString() !== '1\n') {
    throw new Error(`package CLI smoke test failed with exit code ${String(cliResult.exitCode)}`);
  }
  console.log('package CLI count smoke passed');

  const linesResult = Bun.spawnSync({
    cmd: [
      'bunx',
      '@konstit/csv',
      'lines',
      csvPath,
      '--delimiter',
      ';',
      '--columns',
      '0,1',
      '--where-prefix',
      '1=A',
      '--json',
      '--limit',
      '1',
    ],
    cwd: directory,
    stderr: 'inherit',
    stdout: 'pipe',
  });
  if (!linesResult.success || linesResult.stdout.toString() !== '["1","Ada"]\n') {
    throw new Error(`package CLI lines smoke test failed with exit code ${String(linesResult.exitCode)}`);
  }
  console.log('package CLI lines smoke passed');
} finally {
  await rm(directory, { recursive: true, force: true });
}

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    stderr: 'inherit',
    stdout: 'inherit',
  });
  if (!result.success) {
    throw new Error(`${command.join(' ')} failed with exit code ${String(result.exitCode)}`);
  }
}
