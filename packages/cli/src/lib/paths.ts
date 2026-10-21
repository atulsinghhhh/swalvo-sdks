import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { readEnv } from './env.js';

/**
 * ~/.swalvo/, or $SWALVO_CONFIG_DIR for isolated tests and CI. The only
 * place the CLI writes anything.
 */
export function swalvoHomeDir(): string {
  return readEnv('configDir') ?? join(os.homedir(), '.swalvo');
}

/**
 * ~/.raven/, where the CLI kept its files before the Swalvo rename. Only
 * read as a fallback (logout also clears its credentials file), and only
 * when no config dir override is set.
 */
export function legacyHomeDir(): string | undefined {
  return readEnv('configDir') ? undefined : join(os.homedir(), '.raven');
}

/**
 * Where to read `name` from: ~/.swalvo/<name> when it exists, otherwise a
 * pre-rename ~/.raven/<name> when that exists, otherwise ~/.swalvo/<name>.
 * Nothing is moved or deleted; the next write simply lands in ~/.swalvo.
 */
function readPath(name: string): string {
  const current = join(swalvoHomeDir(), name);
  const legacyDir = legacyHomeDir();
  if (legacyDir && !existsSync(current)) {
    const legacy = join(legacyDir, name);
    if (existsSync(legacy)) return legacy;
  }
  return current;
}

/** Where credentials are written. */
export function credentialsFilePath(): string {
  return join(swalvoHomeDir(), 'credentials.json');
}

/** Where credentials are read from (falls back to a pre-rename ~/.raven/credentials.json). */
export function credentialsReadPath(): string {
  return readPath('credentials.json');
}

/** Where CLI config is written. */
export function configFilePath(): string {
  return join(swalvoHomeDir(), 'config.json');
}

/** Where CLI config is read from (falls back to a pre-rename ~/.raven/config.json). */
export function configReadPath(): string {
  return readPath('config.json');
}

/** The per-directory project link `swalvo init` creates. Safe to commit. */
export const PROJECT_CONFIG_FILENAME = 'swalvo.json';

/** The pre-rename project link. Still read when a directory has no swalvo.json. */
export const LEGACY_PROJECT_CONFIG_FILENAME = 'raven.json';
