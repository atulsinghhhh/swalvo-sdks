import { SwalvoError } from './errors';
import { SDK_VERSION } from './version';

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 504]);
const DEFAULT_BASE_URL = 'http://localhost:4100';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 300;

export interface SwalvoClientOptions {
  /** Required. A project API key (`rvk_....secret`). Never hardcode it; pass it from an environment variable your own code reads explicitly, e.g. `apiKey: process.env.SWALVO_API_KEY`. */
  apiKey: string;
  /**
   * Defaults to http://localhost:4100 (local dev). Override for any real
   * deployment. Required — throws `RAVEN_INVALID_CONFIG` instead of
   * silently defaulting — when `NODE_ENV=production` and this is omitted.
   */
  baseUrl?: string;
  /** Request timeout in milliseconds, default 10000. Nothing here hangs forever. */
  timeout?: number;
  /** Max retry attempts for transient failures (network errors, 429/502/503/504). Defaults to 2. */
  maxRetries?: number;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Set false for requests that must never be retried, transient failure or not. */
  retryable?: boolean;
  /** `text` returns the raw body as a string (transcript `.vtt`/`.txt` exports). Default `json`. */
  responseType?: 'json' | 'text';
}

/**
 * The one place this SDK speaks HTTP to the Control API. Every resource goes
 * through here; not one of them builds a `fetch()` of its own (Phase 10
 * spec §8/§9).
 *
 * The API key lives in a private class field and nowhere else. It's never a
 * property on `this` that `Object.keys`, `JSON.stringify` or `console.log`
 * could reach, and this class's own `toString` and inspect output leave it
 * out too (Phase 10 spec §7).
 */
export class SwalvoHttpClient {
  readonly #apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;

  constructor(options: SwalvoClientOptions) {
    if (!options || typeof options !== 'object') {
      throw new SwalvoError('new Swalvo(options) requires a configuration object', { code: 'RAVEN_INVALID_CONFIG' });
    }
    if (!options.apiKey || typeof options.apiKey !== 'string') {
      throw new SwalvoError(
        'apiKey is required; pass your Swalvo project API key, e.g. apiKey: process.env.SWALVO_API_KEY',
        {
          code: 'RAVEN_INVALID_CONFIG',
        },
      );
    }

    // An omitted baseUrl silently falls back to a local dev stack
    // (DEFAULT_BASE_URL below) that plainly does not exist in production —
    // a real client constructed with just an apiKey used to get a silent
    // ECONNREFUSED against localhost:4100 instead of a config error that
    // actually explains itself (external developer report #5). NODE_ENV is
    // the same production signal apps/api's own configuration.ts reads;
    // this only fires when it's unambiguous, never for a request with
    // NODE_ENV unset, e.g. most local dev and test setups.
    if (!options.baseUrl && process.env.NODE_ENV === 'production') {
      throw new SwalvoError(
        'baseUrl is required outside local development. Pass your Swalvo API host, e.g. ' +
          "baseUrl: 'https://api.swalvo.com' (or your self-hosted deployment's URL) — " +
          `omitting it defaults to ${DEFAULT_BASE_URL}, which does not exist in production.`,
        { code: 'RAVEN_INVALID_CONFIG' },
      );
    }

    this.#apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  /** Never returns the API key, so this client is safe to log, inspect or JSON.stringify. */
  toString(): string {
    return `SwalvoHttpClient(${this.baseUrl})`;
  }

  toJSON(): unknown {
    return { baseUrl: this.baseUrl };
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.buildUrl(path, options.query);
    const retryable = options.retryable ?? true;

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#apiKey}`,
            'User-Agent': `Swalvo-Server-SDK/${SDK_VERSION} (node)`,
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        const isTimeout = error instanceof Error && error.name === 'AbortError';
        if (retryable && attempt < this.maxRetries) {
          await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
          attempt++;
          continue;
        }
        throw new SwalvoError(
          isTimeout ? `Request timed out after ${this.timeout}ms` : 'Could not reach the Swalvo API',
          {
            code: isTimeout ? 'RAVEN_TIMEOUT' : 'RAVEN_NETWORK_ERROR',
            cause: error,
          },
        );
      }
      clearTimeout(timer);

      const requestId = response.headers.get('x-request-id') ?? undefined;

      if (response.status === 204) {
        return undefined as T;
      }

      if (response.ok && options.responseType === 'text') {
        return (await response.text()) as T;
      }

      const payload = await response.json().catch(() => undefined);

      if (response.ok) {
        return payload as T;
      }

      if (retryable && RETRYABLE_STATUS_CODES.has(response.status) && attempt < this.maxRetries) {
        await sleep(BASE_RETRY_DELAY_MS * 2 ** attempt);
        attempt++;
        continue;
      }

      throw mapErrorResponse(response.status, payload, requestId);
    }
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }
}

function mapErrorResponse(status: number, payload: unknown, requestId?: string): SwalvoError {
  const message = extractMessage(payload) ?? `Request failed with status ${status}`;
  const code = extractCode(payload) ?? codeForStatus(status);
  return new SwalvoError(message, { code, statusCode: status, requestId, details: payload });
}

function codeForStatus(status: number): string {
  // Same names the API returns, on purpose, so a 401 surfaces as
  // RAVEN_AUTH_ERROR whether the code came from the body or from here. This
  // fallback only fires when a proxy has eaten the JSON body.
  if (status === 401) return 'RAVEN_AUTH_ERROR';
  if (status === 403) return 'RAVEN_PERMISSION_DENIED';
  if (status === 404) return 'RAVEN_NOT_FOUND';
  if (status === 429) return 'RAVEN_RATE_LIMITED';
  if (status >= 500) return 'RAVEN_INTERNAL_ERROR';
  return 'VALIDATION_ERROR';
}

function extractMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const message = (payload as Record<string, unknown>).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  return undefined;
}

function extractCode(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === 'string' ? code : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @deprecated Renamed to {@link SwalvoClientOptions}. */
export type RavenClientOptions = SwalvoClientOptions;
/** @deprecated Renamed to {@link SwalvoHttpClient}. */
export const RavenHttpClient = SwalvoHttpClient;
/** @deprecated Renamed to {@link SwalvoHttpClient}. */
export type RavenHttpClient = SwalvoHttpClient;
