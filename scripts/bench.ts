import { Glob } from 'bun';
import { run } from 'mitata';

const benchmarkDirectory = new URL('../bench/', import.meta.url);
const fileFilters = Bun.argv.slice(2);
const glob = new Glob('**/*.bench.{js,jsx,mjs,cjs,ts,tsx,mts,cts}');
const benchmarkFiles: string[] = [];

for await (const path of glob.scan({ cwd: benchmarkDirectory.pathname, onlyFiles: true })) {
  if (fileFilters.length === 0 || fileFilters.some((filter) => path.includes(filter))) {
    benchmarkFiles.push(path);
  }
}

benchmarkFiles.sort();

if (benchmarkFiles.length === 0) {
  const filterMessage = fileFilters.length === 0 ? '' : ` matching: ${fileFilters.join(', ')}`;
  console.error(`No benchmark files found in bench/${filterMessage}`);
  process.exit(1);
}

for (const path of benchmarkFiles) {
  await import(new URL(path, benchmarkDirectory).href);
}

await run({ throw: true });
