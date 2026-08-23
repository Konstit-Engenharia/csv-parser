export function workerModuleUrl(name: 'count' | 'rows'): string {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  return new URL(`./workers/${name}.worker.${extension}`, import.meta.url).href;
}
