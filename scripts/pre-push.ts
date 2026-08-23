export interface PushUpdate {
  readonly localObject: string;
  readonly localRef: string;
  readonly remoteObject: string;
  readonly remoteRef: string;
}

export interface VersionBump {
  readonly localObject: string;
  readonly version: string;
}

export type VersionReader = (object: string) => Promise<string | undefined>;

const ZERO_OBJECT = /^0+$/;
const GIT_OBJECT = /^[0-9a-f]{40,64}$/i;

if (import.meta.main) {
  await main();
}

async function main(): Promise<void> {
  const registry = normalizeRegistry(process.env['KONSTIT_NPM_REGISTRY']);
  const updates = parsePushUpdates(await Bun.stdin.text());
  const versionBump = registry === undefined ? undefined : await findVersionBump(updates, readPackageVersionAt);

  if (versionBump !== undefined) {
    await requireSafePublishState(versionBump);
  }

  await run([
    process.execPath,
    'run',
    'prepush',
  ], 'pre-push checks');

  if (registry === undefined || versionBump === undefined) {
    return;
  }

  console.log(`Publishing package version ${versionBump.version} to ${registry}`);
  await run([
    process.execPath,
    'publish',
    '--registry',
    registry,
    '--tolerate-republish',
  ], 'package publication');
}

export function parsePushUpdates(input: string): PushUpdate[] {
  const updates: PushUpdate[] = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length !== 4) {
      throw new Error('invalid git pre-push input');
    }
    const [localRef, localObject, remoteRef, remoteObject,] = fields;
    if (
      localRef === undefined || localObject === undefined || remoteRef === undefined || remoteObject === undefined
      || !GIT_OBJECT.test(localObject) || !GIT_OBJECT.test(remoteObject)
    ) {
      throw new Error('invalid git pre-push object ID');
    }
    updates.push({ localObject, localRef, remoteObject, remoteRef });
  }
  return updates;
}

export async function findVersionBump(
  updates: readonly PushUpdate[],
  readVersion: VersionReader,
): Promise<VersionBump | undefined> {
  const versionCache = new Map<string, Promise<string | undefined>>();
  const versionAt = (object: string): Promise<string | undefined> => {
    const cached = versionCache.get(object);
    if (cached !== undefined) {
      return cached;
    }
    const version = readVersion(object);
    versionCache.set(object, version);
    return version;
  };
  const candidates = new Map<string, VersionBump>();

  for (const update of updates) {
    if (ZERO_OBJECT.test(update.localObject) || ZERO_OBJECT.test(update.remoteObject)) {
      continue;
    }
    const [localVersion, remoteVersion,] = await Promise.all([
      versionAt(update.localObject),
      versionAt(update.remoteObject),
    ]);
    if (localVersion === undefined || remoteVersion === undefined || Bun.semver.order(localVersion, remoteVersion) <= 0) {
      continue;
    }
    const candidate = { localObject: update.localObject, version: localVersion };
    candidates.set(`${candidate.localObject}:${candidate.version}`, candidate);
  }

  if (candidates.size > 1) {
    throw new Error('push contains multiple package version bumps; push one package version at a time');
  }
  return candidates.values().next().value;
}

export function normalizeRegistry(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return undefined;
  }

  let registry: URL;
  try {
    registry = new URL(trimmed);
  } catch (error) {
    throw new Error('KONSTIT_NPM_REGISTRY must be a valid URL', { cause: error });
  }
  if (registry.username.length !== 0 || registry.password.length !== 0) {
    throw new Error('KONSTIT_NPM_REGISTRY must not contain credentials');
  }
  if (registry.search.length !== 0 || registry.hash.length !== 0) {
    throw new Error('KONSTIT_NPM_REGISTRY must not contain a query or fragment');
  }
  const loopback = registry.hostname === 'localhost' || registry.hostname === '127.0.0.1' || registry.hostname === '[::1]';
  if (registry.protocol !== 'https:' && !(registry.protocol === 'http:' && loopback)) {
    throw new Error('KONSTIT_NPM_REGISTRY must use HTTPS, except for a loopback registry');
  }
  return registry.href;
}

async function requireSafePublishState(versionBump: VersionBump): Promise<void> {
  const head = await gitOutput(['rev-parse', 'HEAD']);
  if (versionBump.localObject !== head) {
    throw new Error('cannot publish a package version from a pushed object other than HEAD');
  }
  const worktreeVersion = readPackageVersion(await Bun.file('package.json').json());
  if (worktreeVersion !== versionBump.version) {
    throw new Error('working-tree package version does not match the pushed package version');
  }
  const status = await gitOutput(['status', '--porcelain', '--untracked-files=normal']);
  if (status.length !== 0) {
    throw new Error('cannot publish a package version from a dirty worktree');
  }
}

async function readPackageVersionAt(object: string): Promise<string | undefined> {
  const result = Bun.spawnSync({
    cmd: ['git', 'show', `${object}:package.json`],
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (!result.success) {
    const commit = Bun.spawnSync({
      cmd: ['git', 'cat-file', '-e', `${object}^{commit}`],
      cwd: process.cwd(),
      stderr: 'pipe',
      stdout: 'pipe',
    });
    if (!commit.success) {
      throw new Error(`git object is unavailable locally: ${object}`);
    }
    return undefined;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(result.stdout.toString());
  } catch (error) {
    throw new Error(`package.json is invalid at git object ${object}`, { cause: error });
  }
  return readPackageVersion(manifest);
}

function readPackageVersion(manifest: unknown): string {
  if (!isObject(manifest) || typeof manifest['version'] !== 'string') {
    throw new Error('package.json must contain a version string');
  }
  const version = manifest['version'];
  try {
    Bun.semver.order(version, version);
  } catch (error) {
    throw new Error(`package.json contains an invalid semantic version: ${version}`, { cause: error });
  }
  return version;
}

async function gitOutput(arguments_: readonly string[]): Promise<string> {
  const result = Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: process.cwd(),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (!result.success) {
    throw new Error(`git ${arguments_.join(' ')} failed with exit code ${String(result.exitCode)}`);
  }
  return result.stdout.toString().trim();
}

async function run(command: string[], label: string): Promise<void> {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
