// Discovers, filters, imports, and runs the repository's mitata benchmarks.
import { Glob } from 'bun';
import { run } from 'mitata';
import { setBenchmarkNameFilter } from '../bench/benchmark-filter.ts';

const benchmarkDirectory = new URL('../bench/', import.meta.url);
const arguments_ = Bun.argv.slice(2);
const fileFilters: string[] = [];
let benchmarkFilter = /.*/;

for (let index = 0; index < arguments_.length; ++index) {
  const argument = arguments_[index];
  if (argument === undefined) {
    break;
  }
  if (argument !== '--filter') {
    fileFilters.push(argument);
    continue;
  }

  const pattern = arguments_[++index];
  if (pattern === undefined) {
    console.error('Missing benchmark name regex after --filter');
    process.exit(1);
  }

  try {
    benchmarkFilter = new RegExp(pattern);
  } catch {
    console.error(`Invalid benchmark name regex: ${pattern}`);
    process.exit(1);
  }
}

setBenchmarkNameFilter(benchmarkFilter);

const glob = new Glob('**/*.bench.{js,jsx,mjs,cjs,ts,tsx,mts,cts}');
const benchmarkFiles: string[] = [];

for await (const path of glob.scan({ cwd: benchmarkDirectory.pathname, onlyFiles: true })) {
  benchmarkFiles.push(path);
}

if (fileFilters.length > 0) {
  const exactFilters = new Set(fileFilters.filter((filter) => benchmarkFiles.includes(filter)));
  const filteredBenchmarkFiles = benchmarkFiles.filter((path) =>
    fileFilters.some((filter) => exactFilters.has(filter) ? path === filter : path.includes(filter))
  );
  benchmarkFiles.length = 0;
  benchmarkFiles.push(...filteredBenchmarkFiles);
}

benchmarkFiles.sort();

if (benchmarkFiles.length === 0) {
  const filterMessage = fileFilters.length === 0 ? '' : ` matching: ${fileFilters.join(', ')}`;
  console.error(`No benchmark files found in bench/${filterMessage}`);
  process.exit(1);
}

for (const path of benchmarkFiles) {
  console.info(`Importing ${path}`);
  await import(new URL(path, benchmarkDirectory).href);
}

await run({ throw: true, colors: true, filter: benchmarkFilter });
