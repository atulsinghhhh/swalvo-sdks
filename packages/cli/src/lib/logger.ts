import chalk from 'chalk';

let debugEnabled = false;

export function setDebugEnabled(value: boolean): void {
  debugEnabled = value;
}

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

const SENSITIVE_KEYS = /^(token|accesstoken|secret|key|password|credential|authorization)$/i;

/**
 * Deep-redacts an object before it reaches a debug log. Every debug print
 * goes through here, so nobody has to remember to redact by hand at the
 * call site.
 */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEYS.test(key) ? '[redacted]' : redact(val);
    }
    return out;
  }
  return value;
}

/** Structured debug logging. Only prints under --debug, and always redacted first. */
export function debugLog(message: string, data?: unknown): void {
  if (!debugEnabled) return;
  const suffix = data !== undefined ? ` ${JSON.stringify(redact(data))}` : '';
  process.stderr.write(chalk.dim(`[debug] ${message}${suffix}\n`));
}
