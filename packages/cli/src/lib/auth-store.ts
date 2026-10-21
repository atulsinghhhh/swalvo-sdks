import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { decodeSessionToken } from './decode-token.js';
import { readEnvWithName } from './env.js';
import { credentialsFilePath, credentialsReadPath, legacyHomeDir, swalvoHomeDir } from './paths.js';

/** Token env var, i.e. the headless path. Documented in docs/cli.md. The pre-rename $RAVEN_TOKEN is still read, with a deprecation notice. */
export const TOKEN_ENV_VAR = 'SWALVO_TOKEN';

/** True when $SWALVO_TOKEN (or the legacy $RAVEN_TOKEN) holds a non-blank token. */
export function hasEnvToken(): boolean {
  return readEnvWithName('token') !== undefined;
}

export interface StoredCredentials {
  /** Session JWT from the Control API. The CLI reuses the existing auth rather than inventing a second one. */
  token: string;
  email: string;
  /** Which API this token is valid for, so a credential from one endpoint can't silently get reused against another. */
  apiUrl: string;
  createdAt: string;
  /**
   * True when the token came from $SWALVO_TOKEN instead of the credentials
   * file. Commands that would otherwise write to disk (`logout`) check it,
   * so a CI token doesn't get mistaken for one the CLI owns and can revoke
   * locally.
   */
  fromEnvironment?: boolean;
}

/**
 * Credentials from $SWALVO_TOKEN, for CI and anywhere else there's no
 * browser.
 *
 * We decode the email out of the token purely so `whoami` has something to
 * print. If the token won't parse we still return the credential; whether
 * it works is the server's call, not ours.
 *
 * `apiUrl` gets passed in, not read here, so one place,
 * readCliConfig(), stays responsible for resolving it from $SWALVO_API_URL,
 * the config file and the default.
 */
export function credentialsFromEnv(apiUrl: string): StoredCredentials | undefined {
  const fromEnv = readEnvWithName('token');
  const token = fromEnv?.value.trim();
  if (!fromEnv || !token) return undefined;

  return {
    token,
    email: decodeSessionToken(token).email ?? `(token from $${fromEnv.name})`,
    apiUrl,
    createdAt: new Date().toISOString(),
    fromEnvironment: true,
  };
}

/**
 * File-based creds under ~/.swalvo/: chmod 600 on the file, 700 on the
 * directory. The same fallback most CLIs use instead of dragging in an OS
 * keychain dependency. Never logged, never printed, never in --json output.
 */
export async function readCredentials(): Promise<StoredCredentials | undefined> {
  try {
    const raw = await readFile(credentialsReadPath(), 'utf8');
    return JSON.parse(raw) as StoredCredentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeCredentials(credentials: StoredCredentials): Promise<void> {
  const dir = dirname(credentialsFilePath());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(credentialsFilePath(), JSON.stringify(credentials, null, 2), { mode: 0o600 });
  // mkdir's mode only applies at creation, so chmod explicitly in case the
  // directory already existed with looser perms from an older run.
  await chmod(dir, 0o700);
  await chmod(credentialsFilePath(), 0o600);
}

export async function clearCredentials(): Promise<void> {
  await rm(credentialsFilePath(), { force: true });
  // Signing out has to cover a pre-rename ~/.raven/credentials.json too, or
  // readCredentials() would fall back to it and leave the user signed in.
  const legacyDir = legacyHomeDir();
  if (legacyDir) await rm(join(legacyDir, 'credentials.json'), { force: true });
}

export function swalvoHome(): string {
  return swalvoHomeDir();
}
