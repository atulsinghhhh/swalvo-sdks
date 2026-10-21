export interface SwalvoErrorOptions {
  code?: string;
  statusCode?: number;
  requestId?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * The only error type this SDK throws.
 *
 * Built purely from the parsed response body (`{message, code}`, matching
 * `AppError` on the API side) plus response metadata. Never from anything
 * that could be carrying the API key, so there's no route by which a key
 * ends up in here. And never a server stack trace, a database error, or
 * TURN/RTC credentials (Phase 10 spec §10).
 */
export class SwalvoError extends Error {
  readonly code: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(message: string, options: SwalvoErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SwalvoError';
    this.code = options.code ?? 'RAVEN_UNKNOWN_ERROR';
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export function isSwalvoError(value: unknown): value is SwalvoError {
  return value instanceof SwalvoError;
}

/** @deprecated Renamed to {@link SwalvoError}. Same class, so `instanceof` keeps working. */
export const RavenError = SwalvoError;
/** @deprecated Renamed to {@link SwalvoError}. */
export type RavenError = SwalvoError;
/** @deprecated Renamed to {@link SwalvoErrorOptions}. */
export type RavenErrorOptions = SwalvoErrorOptions;
/** @deprecated Renamed to {@link isSwalvoError}. */
export const isRavenError = isSwalvoError;
