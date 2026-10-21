import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readEnv } from './env.js';
import { configFilePath, configReadPath } from './paths.js';

export const DEFAULT_API_URL = 'http://localhost:4100';

/** Overrides the configured apiUrl. The headless counterpart to `swalvo config set apiUrl`. $RAVEN_API_URL and $LIVQENO_API_URL still work, deprecated. */
export const API_URL_ENV_VAR = 'SWALVO_API_URL';

export interface CliConfig {
  apiUrl: string;
  /** Set by `swalvo projects use <project>`. A global fallback, overridden by a directory's swalvo.json or an explicit --project flag. */
  currentProject?: string;
}

const DEFAULTS: CliConfig = { apiUrl: DEFAULT_API_URL };

/**
 * Never contains secrets, so it's safe to print in full via
 * `swalvo config list`.
 *
 * Precedence runs environment > file > default, which lets a CI job point
 * the CLI at a different Control API without writing to the image's home
 * directory. Only apiUrl is overridable this way; currentProject has
 * per-directory `swalvo.json` doing the same job.
 */
export async function readCliConfig(): Promise<CliConfig> {
  const file = await readCliConfigFile();
  const fromEnv = readEnv('apiUrl')?.trim();
  return fromEnv ? { ...file, apiUrl: fromEnv } : file;
}

/**
 * Just the file's contents, ignoring the environment. Writers use this so a
 * read-modify-write never bakes a transient $SWALVO_API_URL into
 * config.json. That override is meant to last exactly one process.
 */
export async function readCliConfigFile(): Promise<CliConfig> {
  try {
    const raw = await readFile(configReadPath(), 'utf8');
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<CliConfig>) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
    throw error;
  }
}

export async function writeCliConfig(config: CliConfig): Promise<void> {
  const dir = dirname(configFilePath());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(configFilePath(), JSON.stringify(config, null, 2));
}

export async function updateCliConfig(patch: Partial<CliConfig>): Promise<CliConfig> {
  const current = await readCliConfigFile();
  const next = { ...current, ...patch };
  await writeCliConfig(next);
  return next;
}

export const CONFIG_KEYS = ['apiUrl', 'currentProject'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(value);
}
