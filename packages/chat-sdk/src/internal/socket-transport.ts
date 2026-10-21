import { SwalvoChatConnectionError, toSwalvoChatError, type SwalvoChatError } from '../errors';
import type { Logger } from '../logger';
import { backoffDelayMs } from './backoff';

/** Injectable, so tests can drive a fake socket with no real server. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** The slice of the WebSocket API this transport actually uses. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface TransportOptions {
  url: string;
  token: string;
  sdkVersion: string;
  autoReconnect: boolean;
  maxReconnectAttempts: number;
  initialReconnectDelayMs: number;
  maxReconnectDelayMs: number;
  logger: Logger;
  socketFactory?: WebSocketFactory;
}

export interface TransportHandlers {
  onFrame: (frame: Record<string, unknown>) => void;
  onOpen: () => void;
  /**
   * `willReconnect: false` means the transport has given up.
   *
   * `terminal: true` says something stronger: retrying could never have
   * helped anyway (a rejected token, a disallowed origin). The client
   * reports `failed` for those and plain `disconnected` for the rest.
   */
  onClose: (info: { code: number; reason: string; willReconnect: boolean; terminal: boolean }) => void;
  onReconnecting: (attempt: number, delayMs: number) => void;
  onError: (error: SwalvoChatError) => void;
}

/**
 * Close codes the gateway sends for failures retrying can't fix.
 *
 * Reconnecting on a revoked token or a rejected origin amounts to a very
 * polite denial-of-service against ourselves.
 */
const TERMINAL_CLOSE_CODES = new Set([
  4401, // auth failed
  4403, // origin not allowed
]);
/** Token expiry is recoverable, but only if the app can hand us a fresh one. */
const TOKEN_EXPIRED_CLOSE_CODE = 4440;
const NORMAL_CLOSURE = 1000;

/**
 * Owns the WebSocket and its reconnect policy. Nothing else.
 *
 * Keeping it separate from the client makes the reconnect logic testable
 * against a fake socket, and means the client never touches a raw
 * `WebSocket`. Which is more or less the whole promise of the SDK
 * (spec §12).
 */
export class SocketTransport {
  private socket?: WebSocketLike;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  /** Set when the caller asked to disconnect, so we don't "helpfully" reconnect anyway. */
  private intentionallyClosed = false;
  private token: string;

  constructor(
    private readonly options: TransportOptions,
    private readonly handlers: TransportHandlers,
  ) {
    this.token = options.token;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === 1;
  }

  /** Swaps in a refreshed token. The next connect or reconnect uses it. */
  setToken(token: string): void {
    this.token = token;
  }

  connect(): void {
    this.intentionallyClosed = false;
    this.open();
  }

  send(frame: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new SwalvoChatConnectionError('Not connected; call connect() first', 'CONNECTION_CLOSED');
    }
    this.socket.send(JSON.stringify(frame));
  }

  disconnect(code = NORMAL_CLOSURE, reason = 'client disconnect'): void {
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    this.attempt = 0;
    // Detach handlers before closing, or the close event fires the very
    // reconnect path we just cancelled.
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close(code, reason);
      } catch {
        // Already closing or closed. Nothing to do.
      }
    }
  }

  private open(): void {
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

    // Token rides in the query string because the browser WebSocket API
    // can't set headers on an upgrade. It's also why chat tokens are
    // short-lived and revocable: a URL can end up in a proxy log.
    const url = `${this.options.url}?token=${encodeURIComponent(this.token)}&sdkVersion=${encodeURIComponent(
      this.options.sdkVersion,
    )}&platform=browser`;

    let socket: WebSocketLike;
    try {
      socket = factory(url);
    } catch (error) {
      this.handlers.onError(
        new SwalvoChatConnectionError('Could not open a chat connection', 'CONNECTION_FAILED', error),
      );
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.handlers.onOpen();
    };

    socket.onmessage = (event) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        this.options.logger.warn('discarded a malformed frame from the server');
        return;
      }
      this.handlers.onFrame(frame);
    };

    socket.onerror = () => {
      // Browsers give no detail here on purpose; it'd be a cross-origin
      // information leak. So there's nothing more specific to report. The
      // close event that follows carries the actual reason.
      this.options.logger.debug('chat socket error');
    };

    socket.onclose = (event) => {
      this.socket = undefined;

      if (this.intentionallyClosed) {
        this.handlers.onClose({
          code: event.code,
          reason: event.reason,
          willReconnect: false,
          terminal: false,
        });
        return;
      }

      const terminal = TERMINAL_CLOSE_CODES.has(event.code);
      const attemptsExhausted = this.attempt >= this.options.maxReconnectAttempts;
      const willReconnect = this.options.autoReconnect && !terminal && !attemptsExhausted;

      // Close first, then error. The client uses `terminal` to choose
      // between `failed` and `disconnected`, and an error emitted before
      // that decision just gets overwritten by it.
      this.handlers.onClose({
        code: event.code,
        reason: event.reason,
        willReconnect,
        terminal: terminal || (this.options.autoReconnect && attemptsExhausted),
      });

      if (terminal) {
        this.handlers.onError(toSwalvoChatError(event.reason || 'UNAUTHORIZED', 'The chat connection was rejected'));
        return;
      }

      if (willReconnect) {
        this.scheduleReconnect(event.code === TOKEN_EXPIRED_CLOSE_CODE);
        return;
      }

      // Auto-reconnect was on and we ran out of attempts. Say so out loud
      // instead of going quiet. A client that silently stops retrying
      // looks exactly like one that's still trying.
      if (this.options.autoReconnect && attemptsExhausted) {
        this.handlers.onError(
          new SwalvoChatConnectionError(
            `Could not reconnect after ${this.options.maxReconnectAttempts} attempts`,
            'CONNECTION_FAILED',
          ),
        );
      }
    };
  }

  private scheduleReconnect(tokenExpired = false): void {
    if (this.intentionallyClosed || !this.options.autoReconnect) {
      return;
    }
    if (this.attempt >= this.options.maxReconnectAttempts) {
      this.handlers.onError(
        new SwalvoChatConnectionError(
          `Could not reconnect after ${this.options.maxReconnectAttempts} attempts`,
          'CONNECTION_FAILED',
        ),
      );
      return;
    }

    this.attempt += 1;
    const delayMs = backoffDelayMs(
      this.attempt,
      this.options.initialReconnectDelayMs,
      this.options.maxReconnectDelayMs,
    );

    this.options.logger.info(
      `reconnecting in ${delayMs}ms (attempt ${this.attempt}/${this.options.maxReconnectAttempts})`,
    );
    this.handlers.onReconnecting(this.attempt, delayMs);

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      // Reconnecting on a token we already know is expired wastes the
      // attempt. The client refreshes it first, via onTokenExpiring.
      void tokenExpired;
      this.open();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
