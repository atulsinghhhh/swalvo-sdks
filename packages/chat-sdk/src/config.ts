import { SwalvoChatAuthenticationError } from './errors';
import type { LogLevel } from './logger';
import type { OutboxStorage } from './outbox';

export interface ChatClientConfig {
  /**
   * The chat token your backend minted via `POST /v1/chat/tokens`. Never
   * mint one in the browser, and never put a project API key here.
   */
  token: string;
  /**
   * WebSocket URL: the `chatUrl` field from the same mint response.
   *
   * Optional only in the sense that `apiUrl` can stand in for it — the SDK
   * derives one from the other. One of the two is required, because a chat
   * token carries no address: its claims are `sub`/`pid`/`cvs`/`scopes`/
   * `exp`/`jti` and nothing else, so there is nothing to self-locate from.
   * Both fields come out of the mint response together, so forward the
   * response and neither has to be thought about:
   *
   * ```ts
   * const grant = await fetch('/api/chat/token').then((r) => r.json());
   * createChatClient(grant);   // token + chatUrl + apiUrl, verbatim
   * ```
   */
  chatUrl?: string;
  /** REST base for history and attachments. The `apiUrl` from the same response. */
  apiUrl?: string;
  logLevel?: LogLevel;
  /** Defaults to true. Set false to handle reconnection yourself. */
  autoReconnect?: boolean;
  /**
   * How many reconnect attempts before giving up and going `failed`.
   * Defaults to 10. The delay is exponential with jitter, capped at
   * `maxReconnectDelayMs`. Never an unbounded retry loop (spec §11).
   */
  maxReconnectAttempts?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** How long to wait for a server ack before rejecting a send. Defaults to 15s. */
  requestTimeoutMs?: number;
  /**
   * Called when the token is about to expire, so the app can fetch a fresh
   * one from its own backend. Hand back the new token and the SDK
   * reconnects with it. Without this the socket just closes at expiry, and
   * somebody has to notice.
   */
  onTokenExpiring?: () => Promise<string> | string;
  /**
   * Offline sends. By default every `sendMessage()` is queued in memory
   * until the server confirms it, and anything the connection dropped is
   * re-sent on reconnect with its original idempotency key — never twice.
   *
   * Pass `{ storage }` to keep the queue across reloads
   * (`new LocalStorageOutboxStorage()` on the web, your own `OutboxStorage`
   * on React Native), or `false` for the pre-outbox behaviour: a failed send
   * is simply rejected and forgotten.
   */
  outbox?: false | { storage?: OutboxStorage };
  /**
   * How long a hole in a conversation's event sequence may stay open
   * before the SDK backfills it from the event log. Defaults to 300 ms;
   * see internal/event-sequencer.ts for why it is not zero.
   */
  gapFillDelayMs?: number;
}

export interface ResolvedChatClientConfig {
  token: string;
  chatUrl: string;
  apiUrl: string;
  logLevel: LogLevel;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  initialReconnectDelayMs: number;
  maxReconnectDelayMs: number;
  requestTimeoutMs: number;
  onTokenExpiring?: () => Promise<string> | string;
  outbox: false | { storage?: OutboxStorage };
  gapFillDelayMs: number;
}

export interface ChatTokenPayload {
  sub: string;
  pid: string;
  cvs: string[];
  scopes: string[];
  exp: number;
  jti: string;
  /**
   * Set on a live-stream audience token (§6): the one `broadcast_audience`
   * conversation this viewer may join, read and post in without being a
   * member of it.
   */
  aud_room?: string;
  /** `VIEWER` on an audience token. */
  role?: string;
}

/**
 * Reads the token's payload. Doesn't verify it; the server's opinion is the
 * only one that counts. This exists so the SDK can fail fast on an
 * already-expired token, and know its own user id without a round trip.
 */
export function decodeChatToken(token: string): ChatTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new SwalvoChatAuthenticationError('Chat token is malformed (expected a JWT with 3 parts)');
  }
  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64)) as ChatTokenPayload;
    if (!payload.sub || !payload.pid || typeof payload.exp !== 'number') {
      throw new Error('missing claims');
    }
    return payload;
  } catch (error) {
    throw new SwalvoChatAuthenticationError('Chat token payload could not be decoded', 'INVALID_TOKEN', error);
  }
}

export function validateConfig(config: ChatClientConfig): ResolvedChatClientConfig {
  if (!config || typeof config !== 'object') {
    throw new SwalvoChatAuthenticationError('createChatClient(config) requires a configuration object');
  }
  if (!config.token || typeof config.token !== 'string') {
    throw new SwalvoChatAuthenticationError(
      'config.token is required; the chat token your backend minted via POST /v1/chat/tokens',
    );
  }

  const payload = decodeChatToken(config.token);
  if (payload.exp * 1000 <= Date.now()) {
    throw new SwalvoChatAuthenticationError('Chat token has already expired', 'TOKEN_EXPIRED');
  }

  const chatUrl = config.chatUrl ?? deriveChatUrl(config.apiUrl);
  if (!chatUrl) {
    throw new SwalvoChatAuthenticationError(
      'createChatClient needs an address as well as a token: pass "chatUrl" or "apiUrl". ' +
        'Both are fields of the POST /v1/chat/tokens response, so forwarding that whole ' +
        'response — createChatClient(grant) — satisfies this.',
    );
  }

  return {
    token: config.token,
    chatUrl,
    apiUrl: config.apiUrl ?? deriveApiUrl(chatUrl),
    logLevel: config.logLevel ?? 'silent',
    autoReconnect: config.autoReconnect ?? true,
    maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    initialReconnectDelayMs: config.initialReconnectDelayMs ?? 500,
    maxReconnectDelayMs: config.maxReconnectDelayMs ?? 30_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 15_000,
    onTokenExpiring: config.onTokenExpiring,
    outbox: config.outbox ?? {},
    gapFillDelayMs: config.gapFillDelayMs ?? 300,
  };
}

/** `https://api.example.com` -> `wss://api.example.com/v1/chat/ws` */
function deriveChatUrl(apiUrl?: string): string | undefined {
  if (!apiUrl) return undefined;
  const ws = apiUrl
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
    .replace(/\/$/, '');
  return `${ws}/v1/chat/ws`;
}

/** The inverse, so passing only `chatUrl` still leaves REST calls working. */
function deriveApiUrl(chatUrl: string): string {
  return chatUrl
    .replace(/^ws:/, 'http:')
    .replace(/^wss:/, 'https:')
    .replace(/\/v1\/chat\/ws$/, '');
}
