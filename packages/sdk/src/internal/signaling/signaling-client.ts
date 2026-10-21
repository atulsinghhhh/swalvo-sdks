import { decodeTokenPayload } from '../../config';
import { RTCError } from '../../errors';
import type { Logger } from '../../logger';
import { TypedEventEmitter } from '../../events';
import type { DisconnectReason, RTCWarning } from '../sfu/types';
import {
  ClientMessageType,
  CloseCode,
  FATAL_ERROR_CODES,
  ServerMessageType,
  type ClientMessage,
  type ServerMessage,
  type ServerLeaveReason,
  type ServerParticipant,
  type SignalingErrorCode,
} from './protocol';

/**
 * How long to wait for the socket to open, and then for `room.joined`.
 *
 * Two values, because they fail for completely different reasons. The
 * first means "can't reach the API"; the second means "the API can't reach
 * an RTC server". One combined timeout would report both as the same
 * thing, which helps nobody.
 */
const OPEN_TIMEOUT_MS = 10_000;
const JOIN_TIMEOUT_MS = 15_000;

/** Reconnect backoff, jittered, so a fleet-wide blip doesn't turn into a thundering herd. */
const RECONNECT_BASE_MS = 300;
const RECONNECT_MAX_MS = 10_000;
const RECONNECT_MAX_ATTEMPTS = 12;

/**
 * Upper bound of the random delay before reconnecting after a graceful API
 * restart (close code 1012). Short, because the media is still alive on
 * the SFU and the resume window is finite; random, because every client on
 * the restarting instance got the same close at the same moment
 * (docs/architecture/phase1-contracts.md §1.3).
 */
const SERVICE_RESTART_JITTER_MS = 2_000;

/**
 * How old a resume token may be and still be offered.
 *
 * The server signs it with a 120 s expiry and sends a fresh one every 60 s
 * (§1.2). Ten seconds of margin covers clock skew and the time the
 * reconnect itself takes; offering a token that might just have expired
 * costs nothing (the server falls back to a fresh join) but not offering
 * one that would have worked costs a full PeerConnection rebuild, so the
 * margin is kept small.
 */
const RESUME_TOKEN_MAX_AGE_MS = 110_000;

/** A token this close to its expiry is refreshed before reconnecting with it. */
const TOKEN_REFRESH_SKEW_MS = 30_000;

/** What the server reports about the room at the moment of joining. */
export interface JoinedPayload {
  roomId: string;
  participants: ServerParticipant[];
  /** The RTC server's name, for diagnostics. Never its address. */
  rtcServer?: string;
  region?: string;
  /** `room.joined.e2ee`: the room requires end-to-end encrypted media. */
  e2ee?: boolean;
  /** Phase 7: `room.joined.capabilities`, e.g. `data.v2`. Empty from an older server. */
  capabilities?: string[];
  /**
   * True when this join re-bound the previous SFU session (§1.2): the
   * existing PeerConnection is still the live one and must be kept. False
   * on a first join and whenever the server fell back to a fresh session.
   */
  resumed: boolean;
}

export interface ReconnectingInfo {
  /**
   * Whether the next attempt will ask to resume the previous session. When
   * it will, the media connection may well still be alive and should not be
   * torn down until the server says whether it was kept.
   */
  resuming: boolean;
}

export interface SignalingClientEvents {
  /** Socket opened, room joined. Fires again after every successful reconnect. */
  joined: (payload: JoinedPayload) => void;
  message: (message: ServerMessage) => void;
  /** Connection lost; a reconnect is being attempted. Fires once per attempt. */
  reconnecting: (info: ReconnectingInfo) => void;
  /** Reconnect attempts exhausted, or the failure is not retryable. */
  failed: (error: RTCError, reason: DisconnectReason) => void;
  /**
   * The server ended the session on purpose (§1.5): removed by moderation,
   * or the room closed. Not an error, and never followed by a reconnect.
   */
  ended: (reason: DisconnectReason) => void;
  /** Closed on purpose, via `close()`. */
  closed: () => void;
  /** Something the application may want to know that did not stop the call. */
  warning: (warning: RTCWarning) => void;
}

export interface SignalingClientOptions {
  endpoint: string;
  token: string;
  roomId: string;
  region?: string;
  autoReconnect: boolean;
  logger: Logger;
  /**
   * Hands back a fresh token when the current one is nearly expired or has
   * been rejected outright (spec §21). Without it, a call outlives its
   * token and dies at the next reconnect, or at expiry when the server
   * enforces it.
   */
  refreshToken?: () => Promise<string>;
  /** See `RTCClientConfig.autoSubscribe`. Re-sent on every rejoin, since each one is a fresh SFU session. */
  autoSubscribe?: boolean;
}

/** Why the last join attempt on a socket failed, for the reconnect decision. */
interface JoinFailure {
  serverCode?: SignalingErrorCode;
  closeCode?: number;
}

/**
 * The SDK's signaling connection.
 *
 * # What it owns, and what it doesn't
 *
 * It owns the socket, the join handshake, reconnection and the session's
 * token. It has no idea what a `PeerConnection` is. Every message goes
 * straight to the adapter, which decides what to negotiate. Keeping that
 * line clean is what makes the reconnect logic testable with no WebRTC
 * stack in sight, and what lets the React Native and Flutter clients reuse
 * the same protocol reasoning over a different transport.
 *
 * # Reconnection
 *
 * A reconnect re-runs the join, because that's what the server expects.
 * When the server handed out a resume token (§1.2) and it is still fresh,
 * the join carries it, and the server re-binds the SFU session the old
 * socket had: media never stopped, and `joined` reports `resumed: true` so
 * the adapter keeps its PeerConnection. Otherwise — no token, a stale one,
 * a server that predates resume, or the SFU having already reaped the
 * session — the server allocates a fresh session, `resumed` is false, and
 * the adapter rebuilds its PeerConnection off the offer that follows. The
 * client has to cope with that fresh-session path anyway, for when the
 * network moved under it for longer than the resume window (spec §20).
 *
 * Close codes steer it (see `CloseCode`): 1012 reconnects almost at once,
 * 4003 never reconnects, 4002 never reconnects, and 4001 reconnects only
 * after a successful token refresh.
 */
export class SignalingClient extends TypedEventEmitter<SignalingClientEvents> {
  private socket?: WebSocket;
  private token: string;
  private readonly options: SignalingClientOptions;
  private readonly logger: Logger;

  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** The attempt the timer will run, so `reconnectNow()` can run it early. */
  private pendingAttempt?: () => void;
  private closedByCaller = false;
  private joined = false;

  /** The latest resume token and when it arrived (§1.2). */
  private resume?: { token: string; receivedAt: number };

  /**
   * Set when the server says the session is over for a reason a reconnect
   * cannot fix (`room.left` with a reason, or a `ROOM_CLOSED` error), so
   * the close that follows is reported as that and not retried.
   */
  private endedReason?: DisconnectReason;

  /**
   * The server said this session's token expired (§1.1 enforcement) and a
   * `refreshToken` is configured, so the 4001 close that follows means
   * "refresh and reconnect" rather than "stop".
   */
  private expiredAwaitingRefresh = false;

  /** A `token.refresh` sent and not yet confirmed. Adopted on `token.refreshed`. */
  private pendingRefreshToken?: string;
  private liveRefreshInFlight = false;

  constructor(options: SignalingClientOptions) {
    super();
    this.options = options;
    this.token = options.token;
    this.logger = options.logger;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  /** True while a reconnect is scheduled or in progress. */
  get isReconnecting(): boolean {
    return !this.closedByCaller && !this.joined && this.reconnectAttempts > 0;
  }

  /**
   * Opens the socket and joins the room.
   *
   * Resolves when `room.joined` arrives, not when the socket opens. Resolve
   * on socket-open and the caller still has to sit waiting on an event to
   * find out whether they're actually in the room, which is the same wait
   * with an extra step bolted on.
   *
   * A failure here is the caller's to handle and is never retried in the
   * background: a first join that fails has no session to recover.
   */
  async connect(): Promise<JoinedPayload> {
    this.closedByCaller = false;
    this.endedReason = undefined;
    try {
      return await this.openAndJoin(false);
    } catch (error) {
      this.closedByCaller = true;
      throw error;
    }
  }

  private async openAndJoin(isReconnect: boolean): Promise<JoinedPayload> {
    const socket = await this.openSocket();
    this.socket = socket;
    return this.join(socket, isReconnect);
  }

  private openSocket(): Promise<WebSocket> {
    const url = this.buildUrl();

    return new Promise<WebSocket>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(new RTCError('SIGNALING_ERROR', 'Could not open a signaling connection', error));
        return;
      }

      const timeout = setTimeout(() => {
        socket.close();
        reject(new RTCError('TIMEOUT', `Signaling connection to ${this.options.endpoint} timed out`));
      }, OPEN_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(timeout);
        this.logger.debug('signaling socket open');
        resolve(socket);
      };

      socket.onerror = () => {
        clearTimeout(timeout);
        // A browser WebSocket error event carries no detail whatsoever,
        // by design: saying why a connection failed would be a cross-origin
        // information leak. So this message lists what to check instead of
        // pretending to know.
        reject(new RTCError('NETWORK_ERROR', `Could not reach the signaling endpoint at ${this.options.endpoint}`));
      };
    });
  }

  private join(socket: WebSocket, isReconnect: boolean): Promise<JoinedPayload> {
    return new Promise<JoinedPayload>((resolve, reject) => {
      let settled = false;
      // Only a socket that completed its join reaches `handleClose`. One
      // that failed during the handshake is the caller's (or the reconnect
      // loop's) to decide about, through the rejection; letting its close
      // event schedule a reconnect as well is how one failure used to turn
      // into two concurrent retry chains, and how a rejected first join
      // kept reconnecting in the background after `connect()` had thrown.
      let joinedOnThisSocket = false;

      const fail = (error: RTCError, failure: JoinFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        (error as RTCError & { joinFailure?: JoinFailure }).joinFailure = failure;
        reject(error);
        try {
          socket.close();
        } catch {
          // Already closing.
        }
      };

      const timeout = setTimeout(() => {
        fail(new RTCError('TIMEOUT', 'The server did not confirm the room join'), {});
      }, JOIN_TIMEOUT_MS);

      socket.onmessage = (event: MessageEvent) => {
        const message = this.parse(event.data);
        if (!message) {
          return;
        }

        // Join handshake resolves here. Everything after it goes to the
        // steady-state handler below.
        if (!settled) {
          if (message.type === ServerMessageType.ROOM_JOINED) {
            settled = true;
            joinedOnThisSocket = true;
            clearTimeout(timeout);
            const askedToResume = isReconnect && sentResume;
            const payload: JoinedPayload = {
              roomId: message.roomId,
              participants: message.participants,
              rtcServer: message.rtcServer,
              region: message.region,
              e2ee: message.e2ee === true,
              capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
              // Only meaningful if we asked. A server that ignores a resume
              // request it does not understand must read as "fresh".
              resumed: askedToResume && message.resumed === true,
            };
            this.storeResumeToken(message.resumeToken);
            this.joined = true;
            this.reconnectAttempts = 0;
            this.logger.info(
              payload.resumed ? 'resumed room session' : 'joined room',
              message.roomId,
              message.rtcServer ? `via ${message.rtcServer}` : '',
            );
            resolve(payload);
            this.emit('joined', payload);
            return;
          }

          if (message.type === ServerMessageType.ERROR) {
            fail(this.toError(message.code, message.message), { serverCode: message.code });
            return;
          }
        }

        this.handleMessage(message);
      };

      socket.onclose = (event: CloseEvent) => {
        if (!joinedOnThisSocket) {
          fail(
            new RTCError(
              'SIGNALING_ERROR',
              `The signaling connection closed before the room was joined (code ${event.code})`,
            ),
            { closeCode: event.code },
          );
          return;
        }
        if (socket !== this.socket) {
          // A socket we already replaced. Its close is history.
          return;
        }
        this.joined = false;
        this.handleClose(event);
      };

      socket.onerror = () => {
        // A post-open error is always followed by a close event, and
        // that's where reconnection gets decided. Nothing to do here except
        // not leave the event unhandled.
      };

      const resume = isReconnect ? this.usableResumeToken() : undefined;
      const sentResume = resume !== undefined;
      this.send({
        type: ClientMessageType.ROOM_JOIN,
        roomId: this.options.roomId,
        region: this.options.region,
        ...(resume ? { resume: { token: resume } } : {}),
        // Only the non-default value goes on the wire, so a join from an
        // application that never set it is byte-for-byte what it was.
        ...(this.options.autoSubscribe === false ? { autoSubscribe: false as const } : {}),
      });
    });
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case ServerMessageType.ERROR:
        if (this.handleErrorFrame(message.code, message.message)) {
          return;
        }
        break;

      case ServerMessageType.ROOM_RESUME_TOKEN:
        this.storeResumeToken(message.resumeToken);
        return;

      case ServerMessageType.TOKEN_EXPIRING:
        void this.refreshLiveToken(message.expiresAt);
        return;

      case ServerMessageType.TOKEN_REFRESHED:
        if (this.pendingRefreshToken) {
          // Adopted only now, so a reconnect never presents a token the
          // server has not accepted for this session.
          this.token = this.pendingRefreshToken;
          this.pendingRefreshToken = undefined;
        }
        this.logger.debug('rtc token refreshed; session now expires at', message.expiresAt);
        return;

      case ServerMessageType.ROOM_LEFT:
        this.handleRoomLeft(message.reason);
        // Still forwarded: nothing downstream acts on it today, and the
        // adapter ignoring a frame it has no use for is the protocol rule.
        break;

      default:
        break;
    }

    this.emit('message', message);
  }

  /**
   * Handles an `error` frame on an established session. Returns true when
   * it was fully handled here and must not reach the adapter.
   */
  private handleErrorFrame(code: SignalingErrorCode, text: string): boolean {
    if (code === 'TOKEN_INVALID') {
      // §1.1: a refused refresh is non-fatal. The session continues on the
      // token it already had, and the application hears about it.
      this.pendingRefreshToken = undefined;
      this.logger.warn('the server refused the refreshed rtc token', text);
      this.emit('warning', { code: 'TOKEN_REFRESH_FAILED', message: text });
      return true;
    }

    if (code === 'ROOM_CLOSED') {
      // The 4003 close that follows is final; remember why.
      this.endedReason = 'ROOM_CLOSED';
      return true;
    }

    if (code === 'TOKEN_EXPIRED' && this.options.refreshToken && this.options.autoReconnect) {
      // Expiry enforced mid-session (§1.1). The server closes with 4001
      // next; with a way to get a new token that is a reconnect, not the
      // end of the call.
      this.expiredAwaitingRefresh = true;
      this.logger.warn('rtc token expired on the server; will refresh and reconnect');
      return true;
    }

    this.logger.warn('signaling error', code, text);
    // Fatal errors end the session. Retryable ones belong to the adapter,
    // glare being the usual suspect, which it sorts out by retrying its
    // offer.
    if (FATAL_ERROR_CODES.has(code)) {
      this.closedByCaller = true;
      this.clearResume();
      // Reported before the socket closes, so the reason and error are in
      // place by the time the close turns into a state change.
      this.emit('failed', this.toError(code, text), code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'CONNECTION_FAILED');
      this.socket?.close();
      return true;
    }
    return false;
  }

  private handleRoomLeft(reason: ServerLeaveReason | undefined): void {
    if (!reason) {
      // The acknowledgement of a leave we asked for.
      return;
    }
    if (reason === 'TOKEN_EXPIRED' && this.options.refreshToken && this.options.autoReconnect) {
      // Same as the `TOKEN_EXPIRED` error frame: recoverable when we can
      // get a new token, so wait for the 4001 and reconnect.
      this.expiredAwaitingRefresh = true;
      return;
    }
    this.endedReason =
      reason === 'REMOVED' || reason === 'ROOM_CLOSED' || reason === 'TOKEN_EXPIRED' ? reason : 'REMOVED';
    this.clearResume();
    // The server closes with 4003 next. Closing first does not depend on
    // that close arriving, and `handleClose` reports `endedReason` either
    // way.
    this.socket?.close(1000, 'session ended by server');
  }

  private handleClose(event: CloseEvent): void {
    if (this.closedByCaller) {
      this.emit('closed');
      return;
    }

    // 4003, or a session the server already said was over: final, whatever
    // `autoReconnect` says. Reconnecting after a removal would put a kicked
    // participant straight back in the room (§1.5).
    if (this.endedReason || event.code === CloseCode.REMOVED) {
      const reason = this.endedReason ?? 'REMOVED';
      this.endedReason = undefined;
      this.closedByCaller = true;
      this.clearResume();
      this.logger.info('the server ended this session', reason);
      this.emit('ended', reason);
      return;
    }

    // 4001 means the server dropped the session on authentication; the SFU
    // session went with it, so there is nothing to resume.
    const authFailed = event.code === CloseCode.AUTH_FAILED || this.expiredAwaitingRefresh;
    if (authFailed) {
      this.clearResume();
    }

    if (!this.options.autoReconnect) {
      this.closedByCaller = true;
      this.emit(
        'failed',
        authFailed
          ? new RTCError('TOKEN_EXPIRED', 'The signaling connection was closed because the RTC token expired')
          : new RTCError('NETWORK_ERROR', `The signaling connection closed (code ${event.code})`),
        authFailed ? 'TOKEN_EXPIRED' : 'CONNECTION_FAILED',
      );
      return;
    }

    if (authFailed) {
      this.expiredAwaitingRefresh = false;
      if (!this.options.refreshToken) {
        // Reconnecting with the token that was just rejected gets rejected
        // again. Without a way to get another one, this is the end.
        this.closedByCaller = true;
        this.emit(
          'failed',
          new RTCError(
            'TOKEN_EXPIRED',
            'The RTC token expired. Pass refreshToken to createRTCClient() to keep long sessions alive',
          ),
          'TOKEN_EXPIRED',
        );
        return;
      }
      void this.scheduleReconnect({ refreshFirst: true });
      return;
    }

    if (event.code === CloseCode.SERVICE_RESTART) {
      // §1.3: the API is restarting and the media is still up on the SFU.
      // Come straight back with the resume token, spread over two seconds.
      this.logger.info('signaling server restarting; reconnecting with resume');
      void this.scheduleReconnect({ serviceRestart: true });
      return;
    }

    void this.scheduleReconnect({});
  }

  private async scheduleReconnect(options: { refreshFirst?: boolean; serviceRestart?: boolean }): Promise<void> {
    if (this.closedByCaller) {
      return;
    }
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.closedByCaller = true;
      this.emit(
        'failed',
        new RTCError('CONNECTION_FAILED', `Could not re-establish signaling after ${RECONNECT_MAX_ATTEMPTS} attempts`),
        'CONNECTION_FAILED',
      );
      return;
    }

    this.reconnectAttempts++;
    this.emit('reconnecting', { resuming: this.usableResumeToken() !== undefined });

    if (options.refreshFirst || this.tokenExpiresSoon()) {
      // Refreshed only when it is needed: after an auth failure, or when
      // the token is about to run out (a reconnect following a long outage
      // very often carries an expired one). Calling the application's
      // backend on every network blip would be a request per reconnect for
      // nothing.
      const refreshed = await this.tryRefreshToken();
      if (this.closedByCaller) {
        return;
      }
      if (!refreshed && options.refreshFirst) {
        // The token was rejected and no replacement is to be had, so a
        // retry would be rejected the same way. Still retried, with
        // backoff: `refreshToken` failing is very often the application's
        // own backend being briefly unreachable on the same bad network.
        this.logger.warn('reconnecting without a fresh token; the server may reject it again');
      }
    }

    const delay = options.serviceRestart
      ? Math.random() * SERVICE_RESTART_JITTER_MS
      : // Full jitter. Every client picks somewhere in [0, backoff), so a
        // fleet that all dropped together doesn't all come back together.
        Math.random() * Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS);

    this.logger.info(`signaling reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay)}ms`);

    const attempt = () => {
      this.reconnectTimer = undefined;
      this.pendingAttempt = undefined;
      if (this.closedByCaller) {
        return;
      }
      void this.openAndJoin(true).then(
        () => {
          if (this.closedByCaller) {
            // `close()` was called while this attempt was in flight.
            this.socket?.close(1000, 'client left');
          }
        },
        (error: RTCError & { joinFailure?: JoinFailure }) => this.handleReconnectFailure(error),
      );
    };
    this.pendingAttempt = attempt;
    this.reconnectTimer = setTimeout(attempt, delay);
  }

  /** Decides what a failed reconnect attempt means: retry, refresh, or stop. */
  private handleReconnectFailure(error: RTCError & { joinFailure?: JoinFailure }): void {
    if (this.closedByCaller) {
      return;
    }
    this.logger.warn('signaling reconnect failed', error.message);
    const failure = error.joinFailure ?? {};

    if (failure.serverCode === 'TOKEN_EXPIRED' && this.options.refreshToken) {
      void this.scheduleReconnect({ refreshFirst: true });
      return;
    }
    if (failure.serverCode && FATAL_ERROR_CODES.has(failure.serverCode)) {
      this.closedByCaller = true;
      this.emit('failed', error, failure.serverCode === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'CONNECTION_FAILED');
      return;
    }
    if (failure.closeCode === CloseCode.REMOVED || failure.serverCode === 'ROOM_CLOSED') {
      this.closedByCaller = true;
      this.emit('ended', failure.serverCode === 'ROOM_CLOSED' ? 'ROOM_CLOSED' : 'REMOVED');
      return;
    }
    void this.scheduleReconnect({});
  }

  /**
   * Runs a scheduled reconnect attempt now instead of waiting out its
   * backoff. For a platform that can see the network come back (React
   * Native's NetInfo): the delay exists to spread load and to avoid
   * hammering a dead network, and neither applies once connectivity is
   * known to be back.
   */
  reconnectNow(): void {
    const attempt = this.pendingAttempt;
    if (!attempt || !this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    attempt();
  }

  /**
   * Abandons the current session and joins afresh: a new SFU session and
   * so a new PeerConnection. For when the media connection is dead but
   * signaling is not, where resuming would only re-bind the dead session.
   */
  rejoin(): void {
    if (this.closedByCaller) {
      return;
    }
    this.clearResume();
    if (this.joined && this.socket?.readyState === WebSocket.OPEN) {
      // Our own close runs the ordinary reconnect path, which is exactly a
      // rejoin now that there is no resume token to offer.
      this.socket.close(1000, 'client rejoin');
    }
    // Otherwise a reconnect is already under way, and with the resume
    // token gone it will be a fresh join.
  }

  /**
   * Fetches a fresh token in answer to `token.expiring` and hands it to the
   * live session (§1.1). Without `refreshToken` the application is told
   * instead, since nothing else will.
   */
  private async refreshLiveToken(expiresAt: string): Promise<void> {
    if (!this.options.refreshToken) {
      this.logger.warn('rtc token expiring at', expiresAt, 'and no refreshToken is configured');
      this.emit('warning', {
        code: 'TOKEN_EXPIRING',
        message: `The RTC token expires at ${expiresAt} and no refreshToken is configured`,
        expiresAt,
      });
      return;
    }
    if (this.liveRefreshInFlight) {
      return;
    }
    this.liveRefreshInFlight = true;
    try {
      const token = await this.options.refreshToken();
      this.pendingRefreshToken = token;
      this.send({ type: ClientMessageType.TOKEN_REFRESH, token });
    } catch (error) {
      this.logger.warn('rtc token refresh failed', (error as Error).message);
      this.emit('warning', {
        code: 'TOKEN_REFRESH_FAILED',
        message: `refreshToken() failed: ${(error as Error).message}`,
        expiresAt,
        cause: error,
      });
    } finally {
      this.liveRefreshInFlight = false;
    }
  }

  /** Swaps in a fresh token for the next connection attempt. True if it got one. */
  private async tryRefreshToken(): Promise<boolean> {
    if (!this.options.refreshToken) {
      return false;
    }
    try {
      this.token = await this.options.refreshToken();
      this.pendingRefreshToken = undefined;
      this.logger.debug('rtc token refreshed');
      return true;
    } catch (error) {
      // Not fatal by itself. The existing token may well still be good,
      // and failing the reconnect here turns a recoverable blip into a
      // dropped call.
      this.logger.warn('rtc token refresh failed', (error as Error).message);
      this.emit('warning', {
        code: 'TOKEN_REFRESH_FAILED',
        message: `refreshToken() failed: ${(error as Error).message}`,
        cause: error,
      });
      return false;
    }
  }

  /** Whether the current token is expired or about to be. Unknown expiry reads as "no". */
  private tokenExpiresSoon(): boolean {
    try {
      const { exp } = decodeTokenPayload(this.token);
      return exp !== undefined && exp * 1000 - Date.now() < TOKEN_REFRESH_SKEW_MS;
    } catch {
      return false;
    }
  }

  private storeResumeToken(token: string | undefined): void {
    if (typeof token === 'string' && token.length > 0) {
      this.resume = { token, receivedAt: Date.now() };
    }
  }

  private usableResumeToken(): string | undefined {
    if (!this.resume) {
      return undefined;
    }
    if (Date.now() - this.resume.receivedAt > RESUME_TOKEN_MAX_AGE_MS) {
      return undefined;
    }
    return this.resume.token;
  }

  private clearResume(): void {
    this.resume = undefined;
  }

  /** Replaces the token used by future reconnects (spec §21). */
  setToken(token: string): void {
    this.token = token;
  }

  send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // Dropped, not queued. Every message here describes one moment in a
      // negotiation, and replaying a stale answer after a reconnect is
      // worse than never sending it. The reconnect re-joins and negotiates
      // from scratch anyway.
      this.logger.debug('dropping signaling message, socket not open', message.type);
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  /** Leaves the room and closes the socket. No reconnect afterwards. */
  close(): void {
    this.closedByCaller = true;
    this.clearResume();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.pendingAttempt = undefined;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: ClientMessageType.ROOM_LEAVE });
      this.socket.close(1000, 'client left');
    }
    this.joined = false;
  }

  private buildUrl(): string {
    const base = this.options.endpoint.replace(/\/$/, '');
    // Token rides in a query parameter, because the browser's WebSocket
    // API can't set request headers. It's short-lived by design for exactly
    // this reason, and the connection has to be wss:// in production, which
    // the server's own config validation enforces.
    return `${base}?token=${encodeURIComponent(this.token)}`;
  }

  private parse(data: unknown): ServerMessage | undefined {
    if (typeof data !== 'string') {
      // Swalvo's signaling is text-only. A binary frame means something
      // else has got onto this socket, and guessing at it beats ignoring it
      // exactly never.
      this.logger.warn('ignoring non-text signaling frame');
      return undefined;
    }
    try {
      return JSON.parse(data) as ServerMessage;
    } catch {
      this.logger.warn('ignoring unparseable signaling frame');
      return undefined;
    }
  }

  private toError(code: SignalingErrorCode, message: string): RTCError {
    switch (code) {
      case 'INVALID_TOKEN':
        return new RTCError('INVALID_TOKEN', message);
      case 'TOKEN_EXPIRED':
        return new RTCError('TOKEN_EXPIRED', message);
      case 'TOKEN_REVOKED':
        return new RTCError('TOKEN_REVOKED', message);
      // Surfaced as its own code rather than falling through to
      // SIGNALING_ERROR, so an application can tell "you are out of
      // minutes" from "signaling broke" and show a billing prompt instead
      // of a retry button.
      case 'USAGE_LIMIT_EXCEEDED':
        return new RTCError('USAGE_LIMIT_EXCEEDED', message);
      case 'ROOM_NOT_FOUND':
        return new RTCError('ROOM_NOT_FOUND', message);
      // ORIGIN_NOT_ALLOWED belongs here rather than in the default: the
      // token was valid, it was the page holding it that was not on the
      // project's allow-list. Letting it fall through to SIGNALING_ERROR
      // would bury the server's message naming the dashboard setting to
      // change.
      case 'UNAUTHORIZED':
      case 'PERMISSION_DENIED':
      case 'ORIGIN_NOT_ALLOWED':
        return new RTCError('PERMISSION_DENIED', message);
      case 'ROOM_FULL':
      case 'NO_RTC_CAPACITY':
      case 'RTC_SERVER_UNREACHABLE':
        return new RTCError('CONNECTION_FAILED', message);
      case 'RATE_LIMITED':
        return new RTCError('NETWORK_ERROR', message);
      default:
        return new RTCError('SIGNALING_ERROR', message);
    }
  }
}
