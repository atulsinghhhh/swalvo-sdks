export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVELS: LogLevel[] = ['silent', 'error', 'warn', 'info', 'debug'];

export interface Logger {
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

/**
 * Console-backed logger, prefixed and level-gated. Nothing here redacts
 * anything for you, so don't hand it a raw RTC token or an API key.
 */
export function createLogger(level: LogLevel = 'silent'): Logger {
  const rank = LEVELS.indexOf(level);
  const enabled = (l: LogLevel) => LEVELS.indexOf(l) <= rank;

  return {
    error: (...args) => {
      if (enabled('error')) console.error('[swalvo-chat]', ...args);
    },
    warn: (...args) => {
      if (enabled('warn')) console.warn('[swalvo-chat]', ...args);
    },
    info: (...args) => {
      if (enabled('info')) console.info('[swalvo-chat]', ...args);
    },
    debug: (...args) => {
      if (enabled('debug')) console.debug('[swalvo-chat]', ...args);
    },
  };
}
