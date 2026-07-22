let benchmarkNameFilter = /.*/;

export function setBenchmarkNameFilter(filter: RegExp): void {
  benchmarkNameFilter = filter;
}

export function matchesBenchmarkName(name: string): boolean {
  benchmarkNameFilter.lastIndex = 0;
  return benchmarkNameFilter.test(name);
}
