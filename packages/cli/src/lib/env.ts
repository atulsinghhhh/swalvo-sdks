/**
 * Environment variables the CLI reads, with their pre-rebrand names.
 *
 * The CLI was called `raven` before the Swalvo rename. Every variable now
 * has a `SWALVO_*` name; the old `RAVEN_*` (and, for the API URL, the
 * `LIVQENO_*`) names still work so existing CI jobs keep running, but using
 * one prints a single deprecation notice to stderr per process.
 * Precedence: SWALVO_* > RAVEN_* > LIVQENO_*.
 */
export const ENV_VARS = {
  token: ['SWALVO_TOKEN', 'RAVEN_TOKEN'],
  apiUrl: ['SWALVO_API_URL', 'RAVEN_API_URL', 'LIVQENO_API_URL'],
  configDir: ['SWALVO_CONFIG_DIR', 'RAVEN_CONFIG_DIR'],
  dashboardUrl: ['SWALVO_DASHBOARD_URL', 'RAVEN_DASHBOARD_URL'],
} as const;

export type EnvVarKey = keyof typeof ENV_VARS;

let warnedLegacyEnv = false;

/** The value and the name it was found under, or undefined when none is set (blank counts as unset). */
export function readEnvWithName(key: EnvVarKey): { name: string; value: string } | undefined {
  const [primary, ...legacy] = ENV_VARS[key];
  for (const name of [primary, ...legacy]) {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') continue;
    if (name !== primary && !warnedLegacyEnv) {
      warnedLegacyEnv = true;
      process.stderr.write(`Warning: $${name} is deprecated; set $${primary} instead.\n`);
    }
    return { name, value };
  }
  return undefined;
}

export function readEnv(key: EnvVarKey): string | undefined {
  return readEnvWithName(key)?.value;
}

/** For tests: lets the one-per-process deprecation notice fire again. */
export function resetLegacyEnvWarning(): void {
  warnedLegacyEnv = false;
}
