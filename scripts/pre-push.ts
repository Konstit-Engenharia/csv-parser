await (import.meta.main ? main() : Promise.resolve());

export interface PrePushDependencies {
  readonly run?: typeof run;
}

export async function main(dependencies: PrePushDependencies = {}): Promise<void> {
  await (dependencies.run ?? run)([
    process.execPath,
    'run',
    'prepush',
  ], 'pre-push checks');
}

export async function run(command: string[], label: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stderr: 'inherit',
    stdin: 'ignore',
    stdout: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${String(exitCode)}`);
  }
}
