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
    'import { csv } from \'@konstit/csv-parser\'; const rows = await csv.parse(Buffer.from(\'id,name\\n1,Ada\\n\')); if (rows.length !== 2 || rows[1]?.[1] !== \'Ada\') throw new Error(\'package smoke test failed\');',
  ], directory);
  console.log('package import and native parse smoke passed');
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
