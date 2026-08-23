export function requireBunRuntime(options?: { readonly bunVersion: string | undefined; }): void {
  const bunVersion = options === undefined ? process.versions.bun : options.bunVersion;
  if (bunVersion === undefined) {
    throw new Error('This package requires Bun');
  }
}
