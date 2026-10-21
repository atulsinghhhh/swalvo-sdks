// src/errors.ts
var SwalvoChatError = class extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "SwalvoChatError";
    this.code = code;
    this.cause = cause;
  }
};
var SwalvoChatConnectionError = class extends SwalvoChatError {
  constructor(message, code = "CONNECTION_FAILED", cause) {
    super(code, message, cause);
    this.name = "SwalvoChatConnectionError";
  }
};
var SwalvoChatAuthenticationError = class extends SwalvoChatError {
  constructor(message, code = "INVALID_TOKEN", cause) {
    super(code, message, cause);
    this.name = "SwalvoChatAuthenticationError";
  }
};
var SwalvoChatPermissionError = class extends SwalvoChatError {
  constructor(message, code = "PERMISSION_DENIED", cause) {
    super(code, message, cause);
    this.name = "SwalvoChatPermissionError";
  }
};
var SwalvoMessageError = class extends SwalvoChatError {
  constructor(message, code = "INVALID_MESSAGE", cause) {
    super(code, message, cause);
    this.name = "SwalvoMessageError";
  }
};
var SwalvoRateLimitError = class extends SwalvoChatError {
  constructor(message, retryAfterSeconds, scope) {
    super("RATE_LIMITED", message);
    this.name = "SwalvoRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.scope = scope;
  }
};
var SwalvoModerationError = class extends SwalvoChatError {
  constructor(message, code = "MUTED", cause) {
    super(code, message, cause);
    this.name = "SwalvoModerationError";
  }
};
var SwalvoSlowModeError = class extends SwalvoChatError {
  constructor(message, retryAfterSeconds) {
    super("SLOW_MODE", message);
    this.name = "SwalvoSlowModeError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
};
var SwalvoMessageBlockedError = class extends SwalvoChatError {
  constructor(message, reason) {
    super("MESSAGE_BLOCKED", message);
    this.name = "SwalvoMessageBlockedError";
    this.reason = reason;
  }
};
var SwalvoRoomError = class extends SwalvoChatError {
  constructor(message, code = "ROOM_NOT_FOUND", cause) {
    super(code, message, cause);
    this.name = "SwalvoRoomError";
  }
};
var SwalvoAttachmentError = class extends SwalvoChatError {
  constructor(message, code = "ATTACHMENT_NOT_FOUND", cause) {
    super(code, message, cause);
    this.name = "SwalvoAttachmentError";
  }
};
function isSwalvoChatError(value) {
  return value instanceof SwalvoChatError;
}
function toSwalvoChatError(code, message, extra = {}) {
  const chatCode = code ?? "INTERNAL_ERROR";
  switch (chatCode) {
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
    case "TOKEN_REVOKED":
    case "UNAUTHORIZED":
      return new SwalvoChatAuthenticationError(message, chatCode);
    case "PERMISSION_DENIED":
    case "NOT_A_MEMBER":
    case "ORIGIN_NOT_ALLOWED":
      return new SwalvoChatPermissionError(message, chatCode);
    case "ROOM_NOT_FOUND":
    case "NOT_IN_ROOM":
    case "TOO_MANY_SUBSCRIPTIONS":
    case "CONVERSATION_ARCHIVED":
      return new SwalvoRoomError(message, chatCode);
    case "RATE_LIMITED":
      return new SwalvoRateLimitError(message, extra.retryAfterSeconds, extra.scope);
    case "MUTED":
    case "BANNED":
    case "BLOCKED":
      return new SwalvoModerationError(message, chatCode);
    case "SLOW_MODE":
      return new SwalvoSlowModeError(message, extra.retryAfterSeconds);
    case "MESSAGE_BLOCKED":
      return new SwalvoMessageBlockedError(message, extra.reason);
    case "ATTACHMENT_NOT_FOUND":
    case "ATTACHMENTS_NOT_CONFIGURED":
    case "ATTACHMENT_TOO_LARGE":
      return new SwalvoAttachmentError(message, chatCode);
    case "MESSAGE_NOT_FOUND":
    case "MESSAGE_DELETED":
    case "MESSAGE_TOO_LARGE":
    case "INVALID_MESSAGE":
    case "INVALID_MESSAGE_TYPE":
    case "INVALID_CURSOR":
    case "MESSAGE_CANCELLED":
    case "EVENTS_EXPIRED":
      return new SwalvoMessageError(message, chatCode);
    case "CONNECTION_FAILED":
    case "CONNECTION_CLOSED":
    case "NETWORK_ERROR":
    case "TIMEOUT":
      return new SwalvoChatConnectionError(message, chatCode);
    default:
      return new SwalvoChatError(chatCode, message);
  }
}
function isConnectivityError(error) {
  if (!(error instanceof SwalvoChatError)) return false;
  return error.code === "CONNECTION_CLOSED" || error.code === "CONNECTION_FAILED" || error.code === "NETWORK_ERROR" || error.code === "TIMEOUT";
}
var RavenChatError = SwalvoChatError;
var RavenChatConnectionError = SwalvoChatConnectionError;
var RavenChatAuthenticationError = SwalvoChatAuthenticationError;
var RavenChatPermissionError = SwalvoChatPermissionError;
var RavenMessageError = SwalvoMessageError;
var RavenRateLimitError = SwalvoRateLimitError;
var RavenModerationError = SwalvoModerationError;
var RavenSlowModeError = SwalvoSlowModeError;
var RavenMessageBlockedError = SwalvoMessageBlockedError;
var RavenRoomError = SwalvoRoomError;
var RavenAttachmentError = SwalvoAttachmentError;
var isRavenChatError = isSwalvoChatError;

// src/config.ts
function decodeChatToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new SwalvoChatAuthenticationError("Chat token is malformed (expected a JWT with 3 parts)");
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64));
    if (!payload.sub || !payload.pid || typeof payload.exp !== "number") {
      throw new Error("missing claims");
    }
    return payload;
  } catch (error) {
    throw new SwalvoChatAuthenticationError("Chat token payload could not be decoded", "INVALID_TOKEN", error);
  }
}
function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new SwalvoChatAuthenticationError("createChatClient(config) requires a configuration object");
  }
  if (!config.token || typeof config.token !== "string") {
    throw new SwalvoChatAuthenticationError(
      "config.token is required; the chat token your backend minted via POST /v1/chat/tokens"
    );
  }
  const payload = decodeChatToken(config.token);
  if (payload.exp * 1e3 <= Date.now()) {
    throw new SwalvoChatAuthenticationError("Chat token has already expired", "TOKEN_EXPIRED");
  }
  const chatUrl = config.chatUrl ?? deriveChatUrl(config.apiUrl);
  if (!chatUrl) {
    throw new SwalvoChatAuthenticationError(
      'createChatClient needs an address as well as a token: pass "chatUrl" or "apiUrl". Both are fields of the POST /v1/chat/tokens response, so forwarding that whole response \u2014 createChatClient(grant) \u2014 satisfies this.'
    );
  }
  return {
    token: config.token,
    chatUrl,
    apiUrl: config.apiUrl ?? deriveApiUrl(chatUrl),
    logLevel: config.logLevel ?? "silent",
    autoReconnect: config.autoReconnect ?? true,
    maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
    initialReconnectDelayMs: config.initialReconnectDelayMs ?? 500,
    maxReconnectDelayMs: config.maxReconnectDelayMs ?? 3e4,
    requestTimeoutMs: config.requestTimeoutMs ?? 15e3,
    onTokenExpiring: config.onTokenExpiring,
    outbox: config.outbox ?? {},
    gapFillDelayMs: config.gapFillDelayMs ?? 300
  };
}
function deriveChatUrl(apiUrl) {
  if (!apiUrl) return void 0;
  const ws = apiUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "");
  return `${ws}/v1/chat/ws`;
}
function deriveApiUrl(chatUrl) {
  return chatUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/v1\/chat\/ws$/, "");
}

// src/events.ts
var TypedEventEmitter = class {
  constructor() {
    this.listeners = /* @__PURE__ */ new Map();
  }
  on(event, handler) {
    let set = this.listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.off(event, handler);
    };
  }
  off(event, handler) {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }
  once(event, handler) {
    const wrapped = ((...args) => {
      unsubscribe();
      handler(...args);
    });
    const unsubscribe = this.on(event, wrapped);
    return unsubscribe;
  }
  removeAllListeners(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
  /** Test and diagnostic helper: how many handlers are on an event. */
  listenerCount(event) {
    return this.listeners.get(event)?.size ?? 0;
  }
  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      handler(...args);
    }
  }
};

// src/logger.ts
var LEVELS = ["silent", "error", "warn", "info", "debug"];
function createLogger(level = "silent") {
  const rank = LEVELS.indexOf(level);
  const enabled = (l) => LEVELS.indexOf(l) <= rank;
  return {
    error: (...args) => {
      if (enabled("error")) console.error("[swalvo-chat]", ...args);
    },
    warn: (...args) => {
      if (enabled("warn")) console.warn("[swalvo-chat]", ...args);
    },
    info: (...args) => {
      if (enabled("info")) console.info("[swalvo-chat]", ...args);
    },
    debug: (...args) => {
      if (enabled("debug")) console.debug("[swalvo-chat]", ...args);
    }
  };
}

// src/internal/rest-client.ts
var RestClient = class {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl;
    this.token = token;
  }
  setToken(token) {
    this.token = token;
  }
  async request(path, options = {}) {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== void 0 && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    let response;
    try {
      response = await fetch(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`
        },
        body: options.body !== void 0 ? JSON.stringify(options.body) : void 0
      });
    } catch (error) {
      throw new SwalvoChatConnectionError("Could not reach Swalvo", "NETWORK_ERROR", error);
    }
    if (response.status === 204) {
      return void 0;
    }
    const payload = await response.json().catch(() => void 0);
    if (!response.ok) {
      const error = toSwalvoChatError(
        chatCodeOf(payload),
        payload?.message ?? `Request failed with status ${response.status}`,
        {
          retryAfterSeconds: payload?.retryAfterSeconds,
          reason: payload?.reason,
          scope: payload?.scope
        }
      );
      throw error;
    }
    return payload;
  }
};
function chatCodeOf(payload) {
  if (!payload) return void 0;
  if (payload.legacyCode) return payload.legacyCode;
  if (payload.code?.startsWith("RAVEN_")) return payload.code.slice("RAVEN_".length);
  return payload.code;
}

// src/internal/backoff.ts
function backoffDelayMs(attempt, initialDelayMs, maxDelayMs, random = Math.random) {
  const exponential = Math.min(initialDelayMs * Math.pow(2, Math.max(0, attempt - 1)), maxDelayMs);
  const floor = exponential / 4;
  return Math.round(floor + random() * (exponential - floor));
}

// src/internal/socket-transport.ts
var TERMINAL_CLOSE_CODES = /* @__PURE__ */ new Set([
  4401,
  // auth failed
  4403
  // origin not allowed
]);
var TOKEN_EXPIRED_CLOSE_CODE = 4440;
var NORMAL_CLOSURE = 1e3;
var SocketTransport = class {
  constructor(options, handlers) {
    this.options = options;
    this.handlers = handlers;
    this.attempt = 0;
    /** Set when the caller asked to disconnect, so we don't "helpfully" reconnect anyway. */
    this.intentionallyClosed = false;
    this.token = options.token;
  }
  get isOpen() {
    return this.socket?.readyState === 1;
  }
  /** Swaps in a refreshed token. The next connect or reconnect uses it. */
  setToken(token) {
    this.token = token;
  }
  connect() {
    this.intentionallyClosed = false;
    this.open();
  }
  send(frame) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new SwalvoChatConnectionError("Not connected; call connect() first", "CONNECTION_CLOSED");
    }
    this.socket.send(JSON.stringify(frame));
  }
  disconnect(code = NORMAL_CLOSURE, reason = "client disconnect") {
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    this.attempt = 0;
    const socket = this.socket;
    this.socket = void 0;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try {
        socket.close(code, reason);
      } catch {
      }
    }
  }
  open() {
    const factory = this.options.socketFactory ?? ((url2) => new WebSocket(url2));
    const url = `${this.options.url}?token=${encodeURIComponent(this.token)}&sdkVersion=${encodeURIComponent(
      this.options.sdkVersion
    )}&platform=browser`;
    let socket;
    try {
      socket = factory(url);
    } catch (error) {
      this.handlers.onError(
        new SwalvoChatConnectionError("Could not open a chat connection", "CONNECTION_FAILED", error)
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
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        this.options.logger.warn("discarded a malformed frame from the server");
        return;
      }
      this.handlers.onFrame(frame);
    };
    socket.onerror = () => {
      this.options.logger.debug("chat socket error");
    };
    socket.onclose = (event) => {
      this.socket = void 0;
      if (this.intentionallyClosed) {
        this.handlers.onClose({
          code: event.code,
          reason: event.reason,
          willReconnect: false,
          terminal: false
        });
        return;
      }
      const terminal = TERMINAL_CLOSE_CODES.has(event.code);
      const attemptsExhausted = this.attempt >= this.options.maxReconnectAttempts;
      const willReconnect = this.options.autoReconnect && !terminal && !attemptsExhausted;
      this.handlers.onClose({
        code: event.code,
        reason: event.reason,
        willReconnect,
        terminal: terminal || this.options.autoReconnect && attemptsExhausted
      });
      if (terminal) {
        this.handlers.onError(toSwalvoChatError(event.reason || "UNAUTHORIZED", "The chat connection was rejected"));
        return;
      }
      if (willReconnect) {
        this.scheduleReconnect(event.code === TOKEN_EXPIRED_CLOSE_CODE);
        return;
      }
      if (this.options.autoReconnect && attemptsExhausted) {
        this.handlers.onError(
          new SwalvoChatConnectionError(
            `Could not reconnect after ${this.options.maxReconnectAttempts} attempts`,
            "CONNECTION_FAILED"
          )
        );
      }
    };
  }
  scheduleReconnect(tokenExpired = false) {
    if (this.intentionallyClosed || !this.options.autoReconnect) {
      return;
    }
    if (this.attempt >= this.options.maxReconnectAttempts) {
      this.handlers.onError(
        new SwalvoChatConnectionError(
          `Could not reconnect after ${this.options.maxReconnectAttempts} attempts`,
          "CONNECTION_FAILED"
        )
      );
      return;
    }
    this.attempt += 1;
    const delayMs = backoffDelayMs(
      this.attempt,
      this.options.initialReconnectDelayMs,
      this.options.maxReconnectDelayMs
    );
    this.options.logger.info(
      `reconnecting in ${delayMs}ms (attempt ${this.attempt}/${this.options.maxReconnectAttempts})`
    );
    this.handlers.onReconnecting(this.attempt, delayMs);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.open();
    }, delayMs);
  }
  clearReconnectTimer() {
    if (this.reconnectTimer !== void 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
    }
  }
};

// src/internal/recovery.ts
var RECOVERY_PAGE_SIZE = 100;
var SEEN_IDS_PER_ROOM = 1e3;
var RecoveryTracker = class {
  constructor(deps) {
    this.deps = deps;
    /**
     * room -> the newest message delivered there: its opaque resume point,
     * plus the two public fields used to tell which of two messages is newer.
     */
    this.cursors = /* @__PURE__ */ new Map();
    /** room -> recently delivered ids, newest last. Bounded; see SEEN_IDS_PER_ROOM. */
    this.seen = /* @__PURE__ */ new Map();
  }
  /**
   * Records a delivered message and reports whether it is new.
   *
   * Every delivery path goes through here — live fan-out, catch-up, and
   * history a client loaded itself — so "have I already shown this?" has
   * one answer rather than three.
   */
  accept(message) {
    const room = message.roomId;
    let ids = this.seen.get(room);
    if (!ids) {
      ids = /* @__PURE__ */ new Set();
      this.seen.set(room, ids);
    }
    if (ids.has(message.id)) {
      return false;
    }
    ids.add(message.id);
    if (ids.size > SEEN_IDS_PER_ROOM) {
      const oldest = ids.values().next();
      if (!oldest.done) ids.delete(oldest.value);
    }
    this.advance(room, message);
    return true;
  }
  /**
   * Moves a room's resume point forward, never backwards.
   *
   * History is delivered newest-first, and an application loading an older
   * page must not rewind the live position — otherwise the next reconnect
   * re-reads everything since that page.
   *
   * "Newer" is decided on the message's own `createdAt` and `id`, not on
   * the cursor string. The cursor is base64url, and that alphabet is not in
   * ASCII order, so comparing encoded cursors does not order the messages
   * they point at. `createdAt` then `id` is the same pair the server's
   * keyset compares, in the same order, using only documented public
   * fields — so the client never has to know what a cursor contains.
   */
  advance(room, message) {
    if (!message.cursor) {
      return;
    }
    const current = this.cursors.get(room);
    const next = { cursor: message.cursor, createdAt: message.createdAt, id: message.id };
    if (current === void 0 || isNewer(next, current)) {
      this.cursors.set(room, next);
    }
  }
  /**
   * Notes how far a history page a developer fetched themselves reached,
   * without claiming those messages were delivered.
   *
   * Only the resume point moves; the de-duplication set is left alone. An
   * application that pages through history has decided for itself what to
   * render, and marking those ids as "already delivered" would suppress the
   * live copy of a message it may never have shown. What this does buy is a
   * resume point for a quiet room — one where the socket drops before any
   * live message has arrived, so there would otherwise be nothing to
   * recover from.
   */
  observeHistory(messages) {
    for (const message of messages) {
      this.advance(message.roomId, message);
    }
  }
  /** Whether this room has a resume point yet. */
  has(room) {
    return this.cursors.has(room);
  }
  cursorFor(room) {
    return this.cursors.get(room)?.cursor;
  }
  /** Drops a room's state when the caller leaves it for good. */
  forget(room) {
    this.cursors.delete(room);
    this.seen.delete(room);
  }
  clear() {
    this.cursors.clear();
    this.seen.clear();
  }
  /**
   * Replays everything a room missed, oldest first.
   *
   * Pages forward from the stored resume point until the server says there
   * is no more, so an outage longer than one page is not silently
   * truncated. Each message advances the cursor as it is delivered, so a
   * socket that drops again mid-catch-up resumes from what actually
   * reached the application rather than from where the attempt began.
   */
  async recoverRoom(room) {
    const start = this.cursors.get(room)?.cursor;
    if (!start) {
      return { room, recovered: 0, gap: false };
    }
    let recovered = 0;
    let gap = false;
    let cursor = start;
    let attempt = 0;
    for (; ; ) {
      if (!this.deps.isConnected()) {
        this.deps.logger.debug(`recovery for ${room} interrupted; will resume on the next reconnect`);
        return { room, recovered, gap };
      }
      let page;
      try {
        page = await this.deps.listMessages({ room, after: cursor, limit: RECOVERY_PAGE_SIZE });
        attempt = 0;
      } catch (error) {
        const chatError = error;
        if (chatError?.code === "INVALID_CURSOR") {
          this.deps.logger.warn(`resume point for ${room} was rejected; recovering from the newest page`);
          gap = true;
          this.cursors.delete(room);
          return { room, recovered, gap, error: chatError };
        }
        attempt += 1;
        if (attempt >= this.deps.maxAttempts) {
          this.deps.logger.warn(
            `could not recover ${room} after ${attempt} attempts: ${chatError?.message ?? String(error)}`
          );
          return { room, recovered, gap, error: chatError };
        }
        await this.deps.sleep(this.deps.retryDelayMs(attempt));
        continue;
      }
      if (page.data.length === 0) {
        return { room, recovered, gap };
      }
      for (const message of [...page.data].reverse()) {
        if (this.accept(message)) {
          this.deps.deliver(message);
          recovered += 1;
        }
      }
      const next = page.previousCursor;
      if (!page.hasMore || !next || next === cursor) {
        return { room, recovered, gap };
      }
      cursor = next;
    }
  }
};
function isNewer(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

// src/internal/seq.ts
function parseSeq(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) {
    return BigInt(value);
  }
  return null;
}
function compareSeq(a, b) {
  const left = parseSeq(a);
  const right = parseSeq(b);
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
function normalizeMessage(raw) {
  const message = { ...raw };
  const seq = parseSeq(raw.seq);
  if (seq !== null) {
    message.seq = seq.toString();
  } else {
    delete message.seq;
  }
  if (!Array.isArray(message.mentions)) {
    message.mentions = [];
  }
  if (message.linkPreview === void 0) {
    message.linkPreview = readLinkPreview(message.metadata);
  }
  return message;
}
function readLinkPreview(metadata) {
  if (!metadata || typeof metadata !== "object") return null;
  const preview = metadata.linkPreview;
  if (!preview || typeof preview !== "object") return null;
  const url = preview.url;
  if (typeof url !== "string" || url.length === 0) return null;
  const pick = (key) => {
    const value = preview[key];
    return typeof value === "string" ? value : void 0;
  };
  return {
    url,
    title: pick("title"),
    description: pick("description"),
    imageUrl: pick("imageUrl"),
    siteName: pick("siteName")
  };
}

// src/internal/event-sequencer.ts
var EVENT_PAGE_SIZE = 500;
var EventSequencer = class {
  constructor(deps) {
    this.deps = deps;
    this.rooms = /* @__PURE__ */ new Map();
  }
  /** The highest eventSeq applied in a room, as the server's string form. */
  lastEventSeq(room) {
    return this.rooms.get(room)?.last?.toString() ?? null;
  }
  /** Rooms with a resume point, i.e. ones a reconnect can catch up. */
  knownRooms() {
    return Array.from(this.rooms.entries()).filter(([, state]) => state.last !== null).map(([room]) => room);
  }
  /**
   * Seeds a room's resume point without applying anything: the server's
   * current head, when a join response reports one. Only ever moves the
   * mark for a room that has none, so it can never skip an event this
   * client has not seen.
   */
  baseline(room, eventSeq) {
    const seq = parseSeq(eventSeq);
    if (seq === null) return;
    const state = this.state(room);
    if (state.last === null) state.last = seq;
  }
  /**
   * Feeds one live frame through. Applies it, holds it, or drops it.
   *
   * A frame with no (or an unparseable) `eventSeq` is applied as-is: that
   * is every ephemeral frame, and every frame from a server older than
   * Phase 3.
   */
  ingest(room, frame) {
    const seq = parseSeq(frame.eventSeq);
    if (seq === null) {
      this.deps.apply(frame, "live");
      return;
    }
    const state = this.state(room);
    if (state.syncing) {
      state.held.set(seq, frame);
      return;
    }
    if (state.last === null) {
      state.last = seq;
      this.deps.apply(frame, "live");
      return;
    }
    if (seq <= state.last) {
      this.deps.logger.debug(`dropped duplicate event ${seq} in ${room}`);
      return;
    }
    if (seq === state.last + 1n) {
      state.last = seq;
      this.deps.apply(frame, "live");
      this.drainContiguous(state, "live");
      if (state.held.size === 0) this.clearGapTimer(state);
      return;
    }
    state.held.set(seq, frame);
    this.armGapTimer(room, state);
  }
  /**
   * Marks rooms as syncing ahead of a reconnect's catch-up, so live frames
   * that arrive while the rooms are being re-joined are held rather than
   * applied ahead of the older events the catch-up is about to read.
   */
  beginSync(rooms) {
    for (const room of rooms) {
      const state = this.rooms.get(room);
      if (state && state.last !== null) state.syncing = true;
    }
  }
  /**
   * Reads everything after the room's resume point from the event log and
   * applies it in order, then releases whatever was held meanwhile.
   *
   * Concurrent calls for one room share a single run.
   */
  catchUp(room) {
    const state = this.state(room);
    if (state.running) return state.running;
    this.clearGapTimer(state);
    state.syncing = true;
    const running = this.run(room, state).finally(() => {
      state.syncing = false;
      state.running = void 0;
      this.release(room, state);
    });
    state.running = running;
    return running;
  }
  /** Drops a room's state when the caller leaves it on purpose. */
  forget(room) {
    const state = this.rooms.get(room);
    if (state) this.clearGapTimer(state);
    this.rooms.delete(room);
  }
  /** Stops timers. Resume points survive, so a later connect still catches up. */
  pause() {
    for (const state of this.rooms.values()) {
      this.clearGapTimer(state);
    }
  }
  async run(room, state) {
    if (state.last === null) {
      return { room, applied: 0, expired: false };
    }
    let applied = 0;
    let attempt = 0;
    for (; ; ) {
      if (!this.deps.isConnected()) {
        this.deps.logger.debug(`event catch-up for ${room} interrupted; will resume on the next reconnect`);
        return { room, applied, expired: false };
      }
      const after = state.last ?? 0n;
      let page;
      try {
        page = await this.deps.fetchEvents(room, after.toString(), EVENT_PAGE_SIZE);
        attempt = 0;
      } catch (error) {
        const chatError = error;
        if (chatError?.code === "EVENTS_EXPIRED") {
          this.deps.logger.warn(`event log for ${room} no longer reaches ${after}; re-reading history`);
          state.last = null;
          try {
            await this.deps.onExpired(room);
          } catch (resyncError) {
            return { room, applied, expired: true, error: resyncError };
          }
          return { room, applied, expired: true };
        }
        attempt += 1;
        if (attempt >= this.deps.maxAttempts) {
          this.deps.logger.warn(
            `could not catch up events in ${room} after ${attempt} attempts: ${chatError?.message ?? String(error)}`
          );
          return { room, applied, expired: false, error: chatError };
        }
        await this.deps.sleep(this.deps.retryDelayMs(attempt));
        continue;
      }
      const records = (page.events ?? []).map((record) => ({ record, seq: parseSeq(record.eventSeq) })).filter((entry) => entry.seq !== null).sort((a, b) => a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);
      let advanced = false;
      for (const { record, seq } of records) {
        if (state.last !== null && seq <= state.last) continue;
        state.last = seq;
        advanced = true;
        state.held.delete(seq);
        this.deps.apply(toFrame(record), "catchup");
        applied += 1;
      }
      if (!page.hasMore || !advanced) {
        return { room, applied, expired: false };
      }
    }
  }
  /**
   * Applies what was held during a catch-up, in seq order.
   *
   * After a catch-up the log has been read to its end, so a hole still in
   * front of a held frame is one the server is never going to fill — a
   * blocked user's event, most likely — and is stepped over. Holding the
   * frame until it did would hold the conversation forever.
   */
  release(room, state) {
    if (state.held.size === 0) return;
    const held = Array.from(state.held.entries()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    state.held.clear();
    for (const [seq, frame] of held) {
      if (state.last !== null && seq <= state.last) continue;
      if (state.last !== null && seq !== state.last + 1n) {
        this.deps.logger.debug(`event log has no ${state.last + 1n}..${seq - 1n} in ${room}; continuing past it`);
      }
      state.last = seq;
      this.deps.apply(frame, "live");
    }
  }
  drainContiguous(state, origin) {
    while (state.last !== null) {
      const next = state.last + 1n;
      const frame = state.held.get(next);
      if (!frame) return;
      state.held.delete(next);
      state.last = next;
      this.deps.apply(frame, origin);
    }
  }
  armGapTimer(room, state) {
    if (state.gapTimer !== void 0) return;
    state.gapTimer = setTimeout(() => {
      state.gapTimer = void 0;
      if (state.held.size === 0) return;
      this.deps.logger.debug(`event gap in ${room} did not close by itself; backfilling from the log`);
      void this.catchUp(room);
    }, this.deps.gapFillDelayMs);
  }
  clearGapTimer(state) {
    if (state.gapTimer !== void 0) {
      clearTimeout(state.gapTimer);
      state.gapTimer = void 0;
    }
  }
  state(room) {
    let state = this.rooms.get(room);
    if (!state) {
      state = { last: null, syncing: false, held: /* @__PURE__ */ new Map() };
      this.rooms.set(room, state);
    }
    return state;
  }
};
function toFrame(record) {
  return { ...record.payload ?? {}, type: record.type, eventSeq: String(record.eventSeq) };
}

// src/attachments-api.ts
var AttachmentsApi = class {
  constructor(rest, defaultRoom) {
    this.rest = rest;
    this.defaultRoom = defaultRoom;
  }
  /** Step 1 on its own, for callers driving the upload themselves: progress bars, resumable transfers. */
  createUploadTicket(input) {
    const room = input.room ?? this.defaultRoom();
    return this.rest.request(`/v1/chat/conversations/${encodeURIComponent(room)}/attachments`, {
      method: "POST",
      body: {
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
        metadata: input.metadata
      }
    });
  }
  /**
   * Uploads a file and returns the attachment id to pass as
   * `sendMessage({ attachmentId })`.
   */
  async upload(file, options = {}) {
    const filename = options.filename ?? (file instanceof File ? file.name : "upload");
    const ticket = await this.createUploadTicket({
      filename,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      room: options.room,
      metadata: options.metadata
    });
    let response;
    try {
      response = await fetch(ticket.uploadUrl, {
        method: ticket.uploadMethod,
        headers: ticket.uploadHeaders,
        body: file
      });
    } catch (error) {
      throw new SwalvoAttachmentError("Could not reach object storage to upload the file", "NETWORK_ERROR", error);
    }
    if (!response.ok) {
      throw new SwalvoAttachmentError(
        `Object storage rejected the upload (status ${response.status})`,
        "ATTACHMENT_NOT_FOUND"
      );
    }
    await this.complete(ticket.id);
    return { ...ticket, status: "uploaded" };
  }
  /** Marks an upload finished, making the attachment sendable. */
  complete(attachmentId) {
    return this.rest.request(`/v1/chat/attachments/${encodeURIComponent(attachmentId)}/complete`, {
      method: "POST"
    });
  }
  /**
   * A short-lived signed download URL. Mint one when the user actually
   * clicks. Don't cache them: they expire, and that expiry is exactly what
   * stops a shared link turning into permanent access.
   */
  getDownloadUrl(attachmentId) {
    return this.rest.request(`/v1/chat/attachments/${encodeURIComponent(attachmentId)}/download-url`);
  }
};

// src/moderation-api.ts
var CLEAR = { muted: false, mutedUntil: null, banned: false, bannedUntil: null };
var ModerationApi = class {
  constructor(rest, defaultRoom, request) {
    this.rest = rest;
    this.defaultRoom = defaultRoom;
    this.request = request;
    /** room -> this user's state there. Fed by member.* events and by MUTED/BANNED refusals. */
    this.mine = /* @__PURE__ */ new Map();
  }
  // -------------------------------------------------------------------------
  // Blocks (any user, about themselves)
  // -------------------------------------------------------------------------
  /**
   * Stops this user receiving anything from `userId`: their messages,
   * reactions and typing are not delivered here, their presence is hidden,
   * and a DIRECT conversation between the two refuses sends with `BLOCKED`.
   * The other user is not told.
   */
  async block(userId) {
    await this.rest.request(`/v1/chat/me/blocks/${encodeURIComponent(userId)}`, { method: "POST" });
  }
  async unblock(userId) {
    await this.rest.request(`/v1/chat/me/blocks/${encodeURIComponent(userId)}`, { method: "DELETE" });
  }
  /** Everyone this user has blocked. */
  async listBlocks() {
    const response = await this.rest.request("/v1/chat/me/blocks");
    return listOf(response, ["blocks", "data"]).map(toBlock);
  }
  // -------------------------------------------------------------------------
  // Flags (any member)
  // -------------------------------------------------------------------------
  /**
   * Reports a message to the project's review queue. The message stays
   * visible; a human (or your backend) decides what happens next, and the
   * project receives a `message.flagged` webhook.
   */
  async flagMessage(messageId, reason, note) {
    return this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}/flags`, {
      method: "POST",
      body: { reason, note }
    });
  }
  // -------------------------------------------------------------------------
  // Moderator actions (MODERATOR / ADMIN of the conversation)
  // -------------------------------------------------------------------------
  /**
   * Bans `userId` from a conversation. They are disconnected from it at
   * once, and cannot rejoin, read or send until the ban lifts. Omit
   * `durationSeconds` for a permanent ban.
   */
  ban(userId, options = {}) {
    return this.act("moderation.ban", userId, options);
  }
  unban(userId, options = {}) {
    return this.act("moderation.unban", userId, options);
  }
  /** Lets `userId` keep reading but not send, react or edit. */
  mute(userId, options = {}) {
    return this.act("moderation.mute", userId, options);
  }
  unmute(userId, options = {}) {
    return this.act("moderation.unmute", userId, options);
  }
  // -------------------------------------------------------------------------
  // This user's own state
  // -------------------------------------------------------------------------
  /**
   * Whether this user is muted or banned in a room, from what this client
   * has seen: a `member.muted` / `member.banned` about them, or a send the
   * server refused with `MUTED` / `BANNED`.
   *
   * There is no client-side "am I muted" query in the protocol, so a
   * client that connects while already muted only finds out on its first
   * refused send. Timed states clear themselves once `…Until` has passed.
   */
  getMyState(room) {
    const target = room ?? this.defaultRoom();
    const state = this.mine.get(target);
    if (!state) return { ...CLEAR };
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return {
      muted: state.muted && (state.mutedUntil === null || state.mutedUntil > now),
      mutedUntil: state.muted && (state.mutedUntil === null || state.mutedUntil > now) ? state.mutedUntil : null,
      banned: state.banned && (state.bannedUntil === null || state.bannedUntil > now),
      bannedUntil: state.banned && (state.bannedUntil === null || state.bannedUntil > now) ? state.bannedUntil : null
    };
  }
  /** @internal Folds a member.* event about this user into `getMyState()`. */
  observe(kind, event) {
    const state = { ...this.mine.get(event.roomId) ?? CLEAR };
    switch (kind) {
      case "banned":
        state.banned = true;
        state.bannedUntil = event.expiresAt;
        break;
      case "unbanned":
        state.banned = false;
        state.bannedUntil = null;
        break;
      case "muted":
        state.muted = true;
        state.mutedUntil = event.expiresAt;
        break;
      case "unmuted":
        state.muted = false;
        state.mutedUntil = null;
        break;
    }
    this.mine.set(event.roomId, state);
  }
  /** @internal A send refused with MUTED or BANNED tells us about our state even with no event. */
  observeRefusal(room, code) {
    if (code === "MUTED") {
      const state = this.mine.get(room);
      if (!state?.muted) this.observe("muted", { roomId: room, userId: "", by: null, expiresAt: null });
    } else if (code === "BANNED") {
      const state = this.mine.get(room);
      if (!state?.banned) this.observe("banned", { roomId: room, userId: "", by: null, expiresAt: null });
    }
  }
  async act(type, userId, options) {
    const room = options.room ?? this.defaultRoom();
    await this.request(type, {
      room,
      userId,
      durationSeconds: options.durationSeconds,
      reason: options.reason
    });
  }
};
function listOf(response, keys) {
  if (Array.isArray(response)) return response;
  if (response && typeof response === "object") {
    for (const key of keys) {
      const value = response[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}
function toBlock(raw) {
  return {
    userId: String(raw.userId ?? raw.blockedId ?? ""),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null
  };
}

// src/messages-api.ts
var MessagesApi = class {
  constructor(rest, defaultRoom, sendMessage, onPage) {
    this.rest = rest;
    this.defaultRoom = defaultRoom;
    this.sendMessage = sendMessage;
    this.onPage = onPage;
  }
  /**
   * Message history, newest first.
   *
   * Pagination is cursor-based and never offset-based. Pass the previous
   * page's `nextCursor` as `before` to walk back through history, or its
   * `previousCursor` as `after` to walk forward and catch up on whatever
   * arrived while you were away.
   *
   * ```ts
   * const page = await chat.messages.list({ room: "room_123", limit: 50 });
   * const older = await chat.messages.list({ before: page.nextCursor! });
   * ```
   */
  async list(options = {}) {
    const page = await this.listRaw(options);
    this.onPage?.(page);
    return page;
  }
  /**
   * `list()` without the bookkeeping, for the SDK's own catch-up.
   *
   * Same endpoint, same credential, same authorization — the only
   * difference is that it does not advance the resume point. Recovery has
   * to advance that itself, one message at a time as each is actually
   * delivered, so a socket dropping mid-catch-up cannot leave the cursor
   * ahead of what the application has seen.
   *
   * @internal
   */
  async listRaw(options = {}) {
    const room = options.room ?? this.defaultRoom();
    const page = await this.rest.request(`/v1/chat/conversations/${encodeURIComponent(room)}/messages`, {
      query: {
        limit: options.limit,
        before: options.before,
        after: options.after,
        afterSeq: options.afterSeq,
        beforeSeq: options.beforeSeq,
        threadRootId: options.threadRootId,
        senderId: options.senderId,
        includeDeleted: options.includeDeleted
      }
    });
    return { ...page, data: (page?.data ?? []).map(normalizeMessage) };
  }
  /** Also available as `chat.sendMessage(...)`; both are the same call. */
  send(options) {
    return this.sendMessage(options);
  }
  async get(messageId) {
    return normalizeMessage(await this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}`));
  }
  /**
   * The first page of this message's thread, oldest first: the root and its
   * replies. Threads live in the same store as everything else, so this is
   * a filtered read, not a separate system (spec §26).
   *
   * Long threads are paginated now (§5); this returns the first page only.
   * Use `threadPage()` to walk the rest.
   */
  async thread(messageId) {
    return (await this.threadPage(messageId)).data;
  }
  /**
   * One page of a thread, oldest first. Pass the previous page's
   * `nextCursor` as `cursor` for the next one.
   *
   * Accepts both the paginated response and the bare array older servers
   * return, which comes back as a single page with `hasMore: false`.
   */
  async threadPage(messageId, options = {}) {
    const response = await this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}/thread`, {
      query: { limit: options.limit, cursor: options.cursor ?? void 0 }
    });
    return toCursorPage(response, ["data", "messages", "replies"]);
  }
  /**
   * Full-text search over one conversation's messages (members only).
   * Newest matches first. Matching is word-based, not substring: `"deplo"`
   * does not find "deploy".
   */
  async search(options) {
    const room = options.room ?? this.defaultRoom();
    const response = await this.rest.request(`/v1/chat/conversations/${encodeURIComponent(room)}/search`, {
      query: { q: options.q, limit: options.limit, cursor: options.cursor ?? void 0 }
    });
    return toCursorPage(response, ["data", "messages", "results"]);
  }
  /** Pins a message to its conversation (MODERATOR or ADMIN). Everyone in the room receives `messagePinned`. */
  async pin(messageId) {
    await this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}/pin`, { method: "POST" });
  }
  async unpin(messageId) {
    await this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}/pin`, { method: "DELETE" });
  }
  /** The conversation's pinned messages. */
  async listPins(room) {
    const target = room ?? this.defaultRoom();
    const response = await this.rest.request(`/v1/chat/conversations/${encodeURIComponent(target)}/pins`);
    return listOf(response, ["data", "pins", "messages"]).map(
      (entry) => (
        // A pin row may wrap its message (`{ message, pinnedBy, pinnedAt }`)
        // or be the message itself. Either way the caller gets messages.
        normalizeMessage(
          entry.message && typeof entry.message === "object" ? entry.message : entry
        )
      )
    );
  }
  /**
   * Edits a message. What comes back carries `edited: true` and an
   * `editedAt`. Swalvo never quietly rewrites history (spec §24).
   */
  async update(messageId, changes) {
    return normalizeMessage(
      await this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        body: changes
      })
    );
  }
  /**
   * Soft-deletes a message. It keeps its position and its id but loses its
   * body, so clients can render a placeholder instead of a hole opening up
   * in the middle of a conversation (spec §25).
   */
  async delete(messageId) {
    return normalizeMessage(
      await this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE"
      })
    );
  }
  /** Adding the same reaction twice is a no-op, not a duplicate. */
  addReaction(messageId, emoji) {
    return this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: "POST",
      body: { emoji }
    });
  }
  removeReaction(messageId, emoji) {
    return this.rest.request(
      `/v1/chat/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      { method: "DELETE" }
    );
  }
};
function toCursorPage(response, keys) {
  const data = listOf(response, keys).map((entry) => normalizeMessage(entry));
  const wrapper = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  const nextCursor = typeof wrapper.nextCursor === "string" ? wrapper.nextCursor : null;
  return {
    data,
    nextCursor,
    hasMore: typeof wrapper.hasMore === "boolean" ? wrapper.hasMore : nextCursor !== null
  };
}

// src/inbox.ts
var EMPTY = { conversations: [], totalUnread: 0, loading: false, hasMore: false, loaded: false };
var Inbox = class {
  constructor(deps) {
    this.deps = deps;
    this.snapshot = EMPTY;
    this.listeners = /* @__PURE__ */ new Set();
    this.nextCursor = null;
    this.options = { limit: 30, watch: true, watchLimit: 15 };
    this.watched = /* @__PURE__ */ new Set();
    this.getSnapshot = () => this.snapshot;
    this.subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
  }
  /** The first page. Replaces whatever was loaded, and starts following live updates. */
  async load(options = {}) {
    this.options = { ...this.options, ...options };
    this.startListening();
    this.patch({ loading: true, error: void 0 });
    try {
      const page = await this.deps.query({ limit: this.options.limit });
      this.nextCursor = page.nextCursor;
      this.patch({
        conversations: sortByActivity(page.conversations.map(normalizeRow)),
        hasMore: page.nextCursor !== null,
        loading: false,
        loaded: true
      });
      await this.watchVisible();
    } catch (error) {
      this.patch({ loading: false, error });
    }
    return this.snapshot;
  }
  /** The next page, appended. A no-op once there are no more. */
  async loadMore() {
    if (!this.nextCursor || this.snapshot.loading) return this.snapshot;
    this.patch({ loading: true });
    try {
      const page = await this.deps.query({ limit: this.options.limit, cursor: this.nextCursor });
      this.nextCursor = page.nextCursor;
      this.patch({
        conversations: mergeRows(this.snapshot.conversations, page.conversations.map(normalizeRow)),
        hasMore: page.nextCursor !== null,
        loading: false
      });
    } catch (error) {
      this.patch({ loading: false, error });
    }
    return this.snapshot;
  }
  /**
   * Re-reads the first page and merges it in. Runs by itself after a
   * reconnect, since unwatched conversations heard nothing while the socket
   * was down; call it yourself when the app returns to the foreground.
   */
  async refresh() {
    if (!this.stopListening) return this.snapshot;
    try {
      const page = await this.deps.query({ limit: this.options.limit });
      this.patch({ conversations: mergeRows(this.snapshot.conversations, page.conversations.map(normalizeRow)) });
      if (this.snapshot.conversations.length <= page.conversations.length) {
        this.nextCursor = page.nextCursor;
        this.patch({ hasMore: page.nextCursor !== null });
      }
      await this.watchVisible();
    } catch (error) {
      this.deps.logger.debug(`inbox refresh failed: ${String(error)}`);
    }
    return this.snapshot;
  }
  /** Stops following live updates. The loaded rows stay readable. */
  stop() {
    this.stopListening?.();
    this.stopListening = void 0;
    if (this.refreshTimer !== void 0) clearTimeout(this.refreshTimer);
    this.refreshTimer = void 0;
  }
  /** @internal The server's answer to a read mark: authoritative, so it overwrites the local count. */
  applyReadState(state) {
    this.updateRow(state.roomId, (row) => ({
      ...row,
      unreadCount: state.unreadCount,
      unreadMentions: state.unreadCount === 0 ? 0 : row.unreadMentions,
      lastReadSeq: state.unreadCount === 0 && row.lastMessage?.seq ? row.lastMessage.seq : row.lastReadSeq
    }));
  }
  /** @internal Reflects a notification preference change made through the client. */
  applyPreferences(preferences) {
    this.updateRow(preferences.roomId, (row) => ({
      ...row,
      muted: preferences.muted,
      notifications: preferences.notifications
    }));
  }
  startListening() {
    if (this.stopListening) return;
    this.stopListening = this.deps.listen({
      message: (message) => this.onMessage(message),
      read: (event) => this.onRead(event),
      removed: (roomId) => this.removeRow(roomId),
      reconnected: () => void this.refresh()
    });
  }
  onMessage(message) {
    const row = this.snapshot.conversations.find((candidate) => candidate.id === message.roomId);
    if (!row) {
      this.scheduleRefresh();
      return;
    }
    const alreadyCounted = row.lastMessage?.seq != null && message.seq != null && compareSeq(message.seq, row.lastMessage.seq) <= 0;
    if (alreadyCounted) return;
    const me = this.deps.userId();
    const fromSomeoneElse = message.senderId !== me;
    const unreadByMark = row.lastReadSeq == null || message.seq == null || compareSeq(message.seq, row.lastReadSeq) > 0;
    const countIt = fromSomeoneElse && unreadByMark && !message.deleted;
    const mentionsMe = countIt && (message.mentions ?? []).includes(me);
    const next = {
      ...row,
      lastMessage: {
        id: message.id,
        seq: message.seq ?? null,
        senderId: message.senderId,
        content: message.text,
        type: String(message.type).toUpperCase(),
        createdAt: message.createdAt
      },
      // Sending a message is reading the conversation, as far as the
      // server's own count is concerned (§2: adjusted for the caller's own
      // messages). Mirror that.
      unreadCount: fromSomeoneElse ? row.unreadCount + (countIt ? 1 : 0) : 0,
      unreadMentions: fromSomeoneElse ? row.unreadMentions + (mentionsMe ? 1 : 0) : 0,
      lastReadSeq: fromSomeoneElse ? row.lastReadSeq : message.seq ?? row.lastReadSeq,
      updatedAt: message.createdAt > row.updatedAt ? message.createdAt : row.updatedAt
    };
    this.patch({ conversations: sortByActivity(this.snapshot.conversations.map((r) => r === row ? next : r)) });
  }
  onRead(event) {
    if (event.userId !== this.deps.userId()) return;
    const row = this.snapshot.conversations.find((candidate) => candidate.id === event.roomId);
    if (!row) return;
    if (event.messageId && row.lastMessage?.id === event.messageId) {
      this.updateRow(row.id, (current) => ({
        ...current,
        unreadCount: 0,
        unreadMentions: 0,
        lastReadSeq: current.lastMessage?.seq ?? current.lastReadSeq
      }));
      return;
    }
    this.scheduleRefresh();
  }
  removeRow(roomId) {
    if (!this.snapshot.conversations.some((row) => row.id === roomId)) return;
    this.watched.delete(roomId);
    this.patch({ conversations: this.snapshot.conversations.filter((row) => row.id !== roomId) });
  }
  updateRow(roomId, update) {
    let changed = false;
    const conversations = this.snapshot.conversations.map((row) => {
      if (row.id !== roomId) return row;
      changed = true;
      return update(row);
    });
    if (changed) this.patch({ conversations });
  }
  async watchVisible() {
    if (!this.options.watch) return;
    for (const row of this.snapshot.conversations) {
      if (this.watched.size >= this.options.watchLimit) return;
      if (this.watched.has(row.id)) continue;
      this.watched.add(row.id);
      try {
        await this.deps.joinRoom(row.id);
      } catch (error) {
        this.watched.delete(row.id);
        this.deps.logger.debug(`inbox could not watch ${row.id}: ${String(error)}`);
      }
    }
  }
  /** Coalesces a burst of "I need the server's view" into one request. */
  scheduleRefresh() {
    if (this.refreshTimer !== void 0) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = void 0;
      void this.refresh();
    }, 250);
  }
  patch(partial) {
    const next = { ...this.snapshot, ...partial };
    next.totalUnread = next.conversations.reduce(
      (total, row) => total + (row.muted || row.notifications === "none" ? 0 : row.unreadCount),
      0
    );
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
};
function normalizeRow(row) {
  return {
    ...row,
    name: row.name ?? null,
    metadata: row.metadata ?? {},
    muted: row.muted ?? false,
    unreadCount: row.unreadCount ?? 0,
    unreadMentions: row.unreadMentions ?? 0,
    lastReadSeq: row.lastReadSeq ?? null,
    lastMessage: row.lastMessage ? { ...row.lastMessage, seq: row.lastMessage.seq == null ? null : String(row.lastMessage.seq) } : null
  };
}
function sortByActivity(rows) {
  return [...rows].sort((a, b) => activityOf(b).localeCompare(activityOf(a)));
}
function activityOf(row) {
  const last = row.lastMessage?.createdAt ?? "";
  return last > row.updatedAt ? last : row.updatedAt;
}
function mergeRows(current, incoming) {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return sortByActivity(Array.from(byId.values()));
}

// src/outbox.ts
var MemoryOutboxStorage = class {
  constructor() {
    this.entries = [];
  }
  load() {
    return this.entries.map((entry) => ({ ...entry }));
  }
  save(entries) {
    this.entries = entries.map((entry) => ({ ...entry }));
  }
};
var LocalStorageOutboxStorage = class {
  constructor(key = "raven-chat-outbox", storage = typeof localStorage !== "undefined" ? localStorage : void 0) {
    this.key = key;
    this.storage = storage;
  }
  load() {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
    } catch {
      return [];
    }
  }
  save(entries) {
    try {
      this.storage?.setItem(this.key, JSON.stringify(entries));
    } catch {
    }
  }
};
var MAX_RATE_LIMIT_WAITS = 3;
var MAX_RATE_LIMIT_WAIT_MS = 3e4;
var Outbox = class {
  constructor(deps) {
    this.deps = deps;
    this.entries = [];
    this.isLoaded = false;
    /**
     * Saves are chained rather than awaited by the send path, for two
     * reasons. A send must reach the socket in the same tick it was called
     * in — awaiting a storage write first would put an async hop between
     * typing and sending for no gain. And with an async store such as
     * AsyncStorage, two un-chained writes can land in the opposite order and
     * resurrect an entry that was already sent.
     */
    this.saveChain = Promise.resolve();
  }
  /** Loads whatever a previous session left behind. Idempotent. */
  ready() {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const stored = await this.deps.storage.load();
          const known = new Set(this.entries.map((entry) => entry.clientMessageId));
          for (const entry of stored ?? []) {
            if (!isEntry(entry) || known.has(entry.clientMessageId)) continue;
            this.entries.push({ ...entry, status: entry.status === "sending" ? "pending" : entry.status });
          }
          this.entries.sort(byCreatedAt);
        } catch (error) {
          this.deps.logger.warn(`could not load the outbox: ${String(error)}`);
        }
        this.isLoaded = true;
      })();
    }
    return this.loaded;
  }
  /** This user's queued sends, oldest first. Optionally for one room. */
  list(room) {
    const userId = this.deps.userId();
    return this.entries.filter((entry) => entry.userId === userId && (room === void 0 || entry.room === room)).map((entry) => ({ ...entry }));
  }
  get(clientMessageId) {
    const entry = this.find(clientMessageId);
    return entry ? { ...entry } : void 0;
  }
  /**
   * Re-sends a `failed` (or still `pending`) entry now, with its original
   * idempotency key. Resolves with the stored message like `sendMessage()`.
   */
  async retry(clientMessageId) {
    if (!this.isLoaded) await this.ready();
    const entry = this.find(clientMessageId);
    if (!entry) {
      throw new SwalvoMessageError(`No queued message with clientMessageId "${clientMessageId}"`, "MESSAGE_NOT_FOUND");
    }
    if (entry.status === "sending") {
      throw new SwalvoMessageError("That message is already being sent", "INVALID_MESSAGE");
    }
    entry.status = "pending";
    entry.error = void 0;
    this.persist();
    return this.deliver(entry, "direct");
  }
  /**
   * Drops a queued send so it never goes out. Returns `false` when there
   * was nothing to cancel, or when it is already on the wire — a send in
   * flight may already be stored, and pretending to have stopped it would
   * be a lie the next history load exposes.
   */
  async cancel(clientMessageId) {
    await this.ready();
    const entry = this.find(clientMessageId);
    if (!entry || entry.status === "sending") return false;
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    this.persist();
    return true;
  }
  /** @internal Queues a send and attempts it once. Used by `ChatClient.sendMessage()`. */
  async enqueueAndSend(fields) {
    if (!this.isLoaded) await this.ready();
    const existing = this.find(fields.clientMessageId);
    if (existing) {
      if (existing.status === "sending") {
        throw new SwalvoMessageError("A message with that clientMessageId is already being sent", "INVALID_MESSAGE");
      }
      return this.retry(existing.clientMessageId);
    }
    const entry = {
      ...stripUndefined(fields),
      userId: this.deps.userId(),
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      status: "pending",
      attempts: 0
    };
    this.entries.push(entry);
    this.persist();
    return this.deliver(entry, "direct");
  }
  /**
   * Sends every `pending` entry, oldest first, one at a time.
   *
   * One at a time because order matters — two queued messages must arrive
   * in the order they were typed — and because the server's per-user send
   * rate would refuse a burst anyway. Stops at the first connectivity
   * failure: the connection just went again, and the next reconnect calls
   * this again.
   */
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      await this.ready();
      const userId = this.deps.userId();
      for (; ; ) {
        if (!this.deps.isConnected()) return;
        const next = this.entries.find((entry) => entry.userId === userId && entry.status === "pending");
        if (!next) return;
        try {
          await this.deliver(next, "flush");
        } catch (error) {
          if (isConnectivityError(error)) return;
        }
      }
    })().finally(() => {
      this.flushing = void 0;
    });
    return this.flushing;
  }
  async deliver(entry, mode) {
    let rateLimitWaits = 0;
    for (; ; ) {
      entry.status = "sending";
      entry.attempts += 1;
      this.persist();
      try {
        const result = await this.deps.transmit(entry);
        this.deps.onSent?.({ ...entry }, result);
        this.entries = this.entries.filter((candidate) => candidate !== entry);
        this.persist();
        return result;
      } catch (error) {
        const chatError = error instanceof SwalvoChatError ? error : new SwalvoChatError("INTERNAL_ERROR", String(error), error);
        entry.error = {
          code: chatError.code,
          message: chatError.message,
          retryAfterSeconds: chatError.retryAfterSeconds,
          reason: chatError.reason
        };
        if (mode === "flush" && chatError.code === "RATE_LIMITED" && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
          rateLimitWaits += 1;
          entry.status = "pending";
          this.persist();
          const seconds = chatError.retryAfterSeconds ?? 1;
          await this.deps.sleep(Math.min(seconds * 1e3, MAX_RATE_LIMIT_WAIT_MS));
          if (!this.deps.isConnected()) throw markQueued(chatError, entry);
          continue;
        }
        if (isConnectivityError(chatError)) {
          entry.status = "pending";
          this.persist();
          throw markQueued(chatError, entry);
        }
        entry.status = "failed";
        this.persist();
        chatError.clientMessageId = entry.clientMessageId;
        throw chatError;
      }
    }
  }
  find(clientMessageId) {
    const userId = this.deps.userId();
    return this.entries.find((entry) => entry.clientMessageId === clientMessageId && entry.userId === userId);
  }
  /** Resolves once every save queued so far has reached storage. Mostly for tests. */
  settled() {
    return this.saveChain;
  }
  persist() {
    const snapshot = this.entries.map((entry) => ({ ...entry }));
    this.saveChain = this.saveChain.then(async () => {
      try {
        await this.deps.storage.save(snapshot);
      } catch (error) {
        this.deps.logger.warn(`could not persist the outbox: ${String(error)}`);
      }
    });
    this.deps.onChange(this.list());
  }
};
function markQueued(error, entry) {
  error.queued = true;
  error.clientMessageId = entry.clientMessageId;
  return error;
}
function byCreatedAt(a, b) {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}
function isEntry(value) {
  if (!value || typeof value !== "object") return false;
  const entry = value;
  return typeof entry.clientMessageId === "string" && typeof entry.room === "string" && typeof entry.userId === "string";
}
function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== void 0));
}

// src/version.ts
var CHAT_SDK_VERSION = "0.1.0";

// src/client.ts
var ChatClient = class extends TypedEventEmitter {
  /** @internal Use `createChatClient(config)`. The second parameter exists purely so tests can inject a fake socket. */
  constructor(config, socketFactory) {
    super();
    this.state = "idle";
    /** Rooms the caller asked to be in. Re-joined automatically after a reconnect. */
    this.desiredRooms = /* @__PURE__ */ new Set();
    this.pending = /* @__PURE__ */ new Map();
    this.requestCounter = 0;
    this.hasConnectedBefore = false;
    /** Local stop-typing timers, so a dropped `typing.stop` can't leave someone stuck typing. */
    this.typingTimers = /* @__PURE__ */ new Map();
    /**
     * Live messages that arrived while a catch-up was still running, held
     * back so they cannot overtake the older messages being replayed.
     */
    this.pendingLive = /* @__PURE__ */ new Map();
    this.recovering = false;
    /**
     * What the caller called a room -> the conversation's public id, learned
     * from join responses. A room can be joined by name or by an attached RTC
     * room id, but every frame and every resume point is keyed on the
     * `conv_…` id, and the two have to be matched up to recover it.
     */
    this.roomAliases = /* @__PURE__ */ new Map();
    this.config = config;
    this.logger = createLogger(config.logLevel);
    this.rest = new RestClient(config.apiUrl, config.token);
    this.socketFactory = socketFactory;
    this.messages = new MessagesApi(
      this.rest,
      () => this.defaultRoom(),
      (options) => this.sendMessage(options),
      (page) => this.recovery.observeHistory(page.data)
    );
    this.attachments = new AttachmentsApi(this.rest, () => this.defaultRoom());
    this.moderation = new ModerationApi(
      this.rest,
      () => this.defaultRoom(),
      (type, payload2) => this.request(type, payload2)
    );
    const payload = decodeChatToken(config.token);
    this.currentUserId = payload.sub;
    this.tokenExpiresAt = payload.exp * 1e3;
    this.audienceRoom = payload.aud_room || void 0;
    this.inbox = new Inbox({
      query: (options) => this.queryMyConversations(options),
      userId: () => this.currentUserId,
      joinRoom: (room) => this.joinRoom(room),
      listen: (handlers) => {
        const subscriptions = [
          this.on("message", handlers.message),
          this.on("read", handlers.read),
          this.on("removedFromRoom", (event) => handlers.removed(event.roomId)),
          this.on("reconnected", handlers.reconnected)
        ];
        return () => subscriptions.forEach((unsubscribe) => unsubscribe());
      },
      logger: this.logger
    });
    if (config.outbox !== false) {
      this.outbox = new Outbox({
        storage: config.outbox.storage ?? new MemoryOutboxStorage(),
        userId: () => this.currentUserId,
        transmit: (entry) => this.transmit(entry),
        isConnected: () => this.state === "connected",
        onChange: (entries) => this.emit("outboxChanged", entries),
        onSent: (entry, message) => this.emit("outboxSent", { clientMessageId: entry.clientMessageId, room: entry.room, message }),
        logger: this.logger,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      });
    }
    this.sequencer = new EventSequencer({
      fetchEvents: (room, afterEventSeq, limit) => this.fetchEvents(room, afterEventSeq, limit),
      apply: (frame) => this.dispatchConversationEvent(frame),
      onExpired: (room) => this.resyncRoom(room),
      logger: this.logger,
      isConnected: () => this.state === "connected",
      maxAttempts: 3,
      retryDelayMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 5e3),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      gapFillDelayMs: config.gapFillDelayMs
    });
    this.recovery = new RecoveryTracker({
      // Deliberately the same public, authorized history call an
      // application would make. Recovery has no privileged path into the
      // store, so a room the token cannot read cannot be recovered either.
      listMessages: (options) => this.messages.listRaw(options),
      deliver: (message) => this.emit("message", message),
      logger: this.logger,
      isConnected: () => this.state === "connected",
      maxAttempts: 3,
      retryDelayMs: (attempt) => Math.min(500 * 2 ** (attempt - 1), 5e3),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    });
  }
  /** Who this client speaks as, read from the token. You can't set it from here. */
  get userId() {
    return this.currentUserId;
  }
  get connectionState() {
    return this.state;
  }
  /** Stable for the life of one socket, changes on reconnect. Worth quoting in a bug report. */
  get id() {
    return this.connectionId;
  }
  /** Rooms this client is currently joined to. */
  get rooms() {
    return Array.from(this.desiredRooms);
  }
  /**
   * True for a live-stream audience token (§6): this user is a viewer of
   * one `broadcast_audience` conversation, not a member of it. Viewers can
   * read and post; member-only features — the inbox, read receipts, push —
   * do not apply and their calls are refused locally.
   */
  get isAudienceViewer() {
    return this.audienceRoom !== void 0;
  }
  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  /**
   * Opens the connection and joins the rooms you asked for. Resolves once
   * the server has authenticated the socket, not merely when TCP came up,
   * so a resolved `connect()` really does mean you can send.
   */
  async connect(options = {}) {
    for (const room of [...options.room ? [options.room] : [], ...options.rooms ?? []]) {
      this.desiredRooms.add(room);
    }
    if (this.audienceRoom && this.desiredRooms.size === 0) {
      this.desiredRooms.add(this.audienceRoom);
    }
    if (this.state === "connected") {
      await this.syncRooms();
      return;
    }
    this.setState("connecting");
    this.transport = new SocketTransport(
      {
        url: this.config.chatUrl,
        token: this.config.token,
        sdkVersion: CHAT_SDK_VERSION,
        autoReconnect: this.config.autoReconnect,
        maxReconnectAttempts: this.config.maxReconnectAttempts,
        initialReconnectDelayMs: this.config.initialReconnectDelayMs,
        maxReconnectDelayMs: this.config.maxReconnectDelayMs,
        logger: this.logger,
        socketFactory: this.socketFactory
      },
      {
        onOpen: () => this.logger.debug("socket open, waiting for server hello"),
        onFrame: (frame) => this.handleFrame(frame),
        onClose: (info) => this.handleClose(info),
        onReconnecting: (attempt) => {
          this.setState("reconnecting");
          this.emit("reconnecting", attempt);
        },
        onError: (error) => this.fail(error)
      }
    );
    const connected = new Promise((resolve, reject) => {
      this.connectPromise = { resolve, reject };
    });
    this.transport.connect();
    await connected;
    await this.syncRooms();
    void this.outbox?.flush();
  }
  /** Closes the connection. No reconnect; call `connect()` again to come back. */
  async disconnect() {
    this.clearTokenRefreshTimer();
    for (const timer of this.typingTimers.values()) clearTimeout(timer);
    this.typingTimers.clear();
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new SwalvoChatConnectionError("Connection closed before the server replied", "CONNECTION_CLOSED"));
    }
    this.pending.clear();
    this.transport?.disconnect();
    this.transport = void 0;
    this.connectionId = void 0;
    this.pendingLive.clear();
    this.recovering = false;
    this.sequencer.pause();
    this.setState("disconnected");
  }
  /**
   * Force a reconnect right now. Rarely needed, since the SDK reconnects
   * on its own, but handy when the app knows the network changed (an
   * `online` event, say) and doesn't fancy waiting out the backoff.
   *
   * Literally a `disconnect()` followed by a `connect()`, rather than its
   * own teardown. It used to have one, and that copy had drifted: it
   * dropped the transport but left `state` on `'connected'`, so the
   * `connect()` on the next line took its already-up early return, found
   * nothing to reconnect, and returned happily. The client was then
   * permanently deaf — state `'connected'`, no socket, no error, no
   * messages ever again — and the only way to notice was that nothing
   * arrived. It also leaked the token-refresh and typing timers and left
   * in-flight requests hanging until their own timeouts.
   *
   * Deferring to `disconnect()` means there is one teardown to be correct
   * about instead of two to keep in step. Resume points survive it, so the
   * new connection still catches up on whatever was missed.
   */
  async reconnect() {
    await this.disconnect();
    await this.connect();
  }
  // -------------------------------------------------------------------------
  // Rooms
  // -------------------------------------------------------------------------
  async joinRoom(room) {
    this.desiredRooms.add(room);
    if (this.state === "connected") {
      this.onJoined(room, await this.request("room.join", { room }));
    }
  }
  async leaveRoom(room) {
    this.desiredRooms.delete(room);
    const resolved = this.resolveRoom(room);
    this.recovery.forget(resolved);
    this.sequencer.forget(resolved);
    this.pendingLive.delete(resolved);
    this.roomAliases.delete(room);
    if (this.state === "connected") {
      await this.request("room.leave", { room });
    }
  }
  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------
  /**
   * Sends a message and resolves with the stored one: canonical server id,
   * canonical timestamp. It only resolves after Swalvo has durably stored
   * it, so a resolved promise really does mean saved (spec §15).
   *
   * If you don't supply a `clientMessageId` we attach one, and that's what
   * makes retrying after a reconnect safe (spec §16).
   */
  async sendMessage(options) {
    const room = options.room ?? this.defaultRoom();
    if (options.mentions && options.mentions.length > MAX_MENTIONS) {
      throw new SwalvoMessageError(`A message can mention at most ${MAX_MENTIONS} users`, "INVALID_MESSAGE");
    }
    const entry = {
      clientMessageId: options.clientMessageId ?? generateClientMessageId(),
      room,
      text: options.text,
      type: options.type,
      replyTo: options.replyTo,
      attachmentId: options.attachmentId,
      metadata: options.metadata,
      mentions: options.mentions
    };
    if (!this.outbox) {
      return this.transmit(entry);
    }
    try {
      return await this.outbox.enqueueAndSend(entry);
    } catch (error) {
      if (error instanceof SwalvoChatError) this.moderation.observeRefusal(this.resolveRoom(room), error.code);
      throw error;
    }
  }
  /**
   * One attempt at putting a message on the wire. The socket when it is up;
   * HTTP when it is not — the message still gets stored and fanned out to
   * everyone else, and losing a connection should not quietly lose whatever
   * the user just typed.
   */
  async transmit(entry) {
    if (this.state !== "connected") {
      const stored = await this.rest.request(
        `/v1/chat/conversations/${encodeURIComponent(entry.room)}/messages`,
        {
          method: "POST",
          body: {
            text: entry.text,
            type: entry.type,
            replyTo: entry.replyTo,
            clientMessageId: entry.clientMessageId,
            attachmentId: entry.attachmentId,
            metadata: entry.metadata,
            mentions: entry.mentions
          }
        }
      );
      return normalizeMessage(stored);
    }
    const ack = await this.request("message.send", {
      room: entry.room,
      text: entry.text,
      messageType: entry.type,
      replyTo: entry.replyTo,
      clientMessageId: entry.clientMessageId,
      attachmentId: entry.attachmentId,
      metadata: entry.metadata,
      mentions: entry.mentions,
      clientSentAt: Date.now()
    });
    return { ...normalizeMessage(ack.message), deduplicated: ack.deduplicated };
  }
  // -------------------------------------------------------------------------
  // Typing / presence / read
  // -------------------------------------------------------------------------
  /**
   * Signals that this user is typing. Call it on every keystroke; it's
   * fine. The server only broadcasts on the transition *into* typing, and
   * this arms a local timer to stop it automatically, so someone who
   * wanders off mid-sentence doesn't sit there "typing…" forever
   * (spec §21).
   */
  async startTyping(room) {
    const target = room ?? this.defaultRoom();
    this.send("typing.start", { room: target });
    const existing = this.typingTimers.get(target);
    if (existing) clearTimeout(existing);
    this.typingTimers.set(
      target,
      setTimeout(() => void this.stopTyping(target).catch(() => void 0), 5e3)
    );
  }
  async stopTyping(room) {
    const target = room ?? this.defaultRoom();
    const timer = this.typingTimers.get(target);
    if (timer) {
      clearTimeout(timer);
      this.typingTimers.delete(target);
    }
    this.send("typing.stop", { room: target });
  }
  /** Marks this message, and everything before it, as read. */
  async markAsRead(messageId) {
    this.assertMember("Read receipts");
    const state = this.state === "connected" ? await this.request("read.mark", { messageId }) : await this.rest.request(`/v1/chat/messages/${encodeURIComponent(messageId)}/read`, {
      method: "POST"
    });
    if (state && typeof state.roomId === "string") this.inbox.applyReadState(state);
    return state;
  }
  /**
   * Sets presence across every room this connection is holding.
   *
   * Remembered and re-asserted on every reconnect. Presence is socket
   * state, so the new socket a reconnect opens knows nothing of what was
   * set on the old one — without this, a client that survived a blip
   * stayed silently invisible to everybody else for the rest of the
   * session.
   */
  async setPresence(status) {
    this.desiredPresence = status;
    this.send("presence.set", { status });
  }
  /**
   * Who is present in a room right now. In a large room (§6) this is the
   * first page of the roster only; use `listPresence()` to walk the rest.
   */
  async getPresence(room) {
    return (await this.listPresence({ room })).data;
  }
  /** One page of a room's presence roster, at most 200 per page. */
  async listPresence(options = {}) {
    const target = options.room ?? this.defaultRoom();
    const response = await this.rest.request(`/v1/chat/conversations/${encodeURIComponent(target)}/presence`, {
      query: { cursor: options.cursor ?? void 0, limit: options.limit }
    });
    const data = listOf(response, ["data", "presence"]).map(
      (entry) => ({ userId: String(entry.userId), status: entry.status })
    );
    const nextCursor = response && typeof response === "object" && !Array.isArray(response) ? response.nextCursor ?? null : null;
    return { data, nextCursor };
  }
  // -------------------------------------------------------------------------
  // Inbox (§2)
  // -------------------------------------------------------------------------
  /**
   * One page of this user's conversations, newest activity first, each with
   * its unread count and last message. For a list that keeps itself up to
   * date, use `chat.inbox` instead — it is built on this.
   */
  async queryMyConversations(options = {}) {
    this.assertMember("The inbox");
    const page = await this.rest.request("/v1/chat/me/conversations", {
      query: { limit: options.limit, cursor: options.cursor ?? void 0 }
    });
    return {
      conversations: (page?.conversations ?? []).map(normalizeRow),
      nextCursor: page?.nextCursor ?? null
    };
  }
  // -------------------------------------------------------------------------
  // Push (§4)
  // -------------------------------------------------------------------------
  /**
   * Registers this device for push. Safe to call on every app start: it is
   * an upsert keyed on the token, and re-binds a token that last belonged
   * to another user on this device (a shared tablet, a sign-out/sign-in) to
   * this one.
   */
  async registerDevice(options) {
    this.assertMember("Push notifications");
    return this.rest.request("/v1/chat/me/devices", {
      method: "POST",
      body: {
        provider: options.provider,
        token: options.token,
        platform: options.platform,
        appBundleId: options.appBundleId
      }
    });
  }
  /** Stops pushes to this device token. Call it on sign-out. */
  async unregisterDevice(token) {
    await this.rest.request(`/v1/chat/me/devices/${encodeURIComponent(token)}`, { method: "DELETE" });
  }
  async listDevices() {
    const response = await this.rest.request("/v1/chat/me/devices");
    return listOf(response, ["devices", "data"]);
  }
  /**
   * Which messages in a room push this user: `all` (the default),
   * `mentions` (only messages that mention them), or `none`.
   */
  async setNotificationLevel(room, level) {
    return this.updateMemberPreferences(room, { notifications: level });
  }
  /**
   * Mutes a conversation for this user: no pushes, and its unread count
   * stops contributing to the inbox badge. Not a moderator mute — this user
   * can still post.
   */
  async muteConversation(room, muted = true) {
    return this.updateMemberPreferences(room, { muted });
  }
  async updateMemberPreferences(room, changes) {
    this.assertMember("Notification preferences");
    const response = await this.rest.request(
      `/v1/chat/me/conversations/${encodeURIComponent(room)}`,
      { method: "PATCH", body: changes }
    );
    const muted = response?.muted ?? changes.muted ?? false;
    const preferences = {
      roomId: response?.roomId ?? response?.id ?? this.resolveRoom(room),
      notifications: response?.notifications ?? changes.notifications ?? (muted ? "none" : "all"),
      muted
    };
    this.inbox.applyPreferences(preferences);
    return preferences;
  }
  /** This user's read position and unread count for a room. */
  async getReadState(room) {
    const target = room ?? this.defaultRoom();
    return this.rest.request(`/v1/chat/conversations/${encodeURIComponent(target)}/read-state`);
  }
  /** Everyone's read position. This is what a "seen by" row is built from. */
  async getReadReceipts(room) {
    const target = room ?? this.defaultRoom();
    return this.rest.request(`/v1/chat/conversations/${encodeURIComponent(target)}/read-receipts`);
  }
  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------
  defaultRoom() {
    const first = this.desiredRooms.values().next();
    if (first.done) {
      throw new SwalvoRoomError(
        "No room selected; pass { room } to connect(), or a `room` option on this call",
        "NOT_IN_ROOM"
      );
    }
    return first.value;
  }
  /** The conversation's public id for whatever the caller called it, once a join has told us. */
  resolveRoom(room) {
    return this.roomAliases.get(room) ?? room;
  }
  /** Remembers what a join told us: the room's public id, and (when the server says) its event head. */
  onJoined(alias, response) {
    if (!response || typeof response !== "object") return;
    const joined = response;
    if (typeof joined.room === "string" && joined.room.length > 0) {
      this.roomAliases.set(alias, joined.room);
      this.sequencer.baseline(joined.room, joined.lastEventSeq ?? joined.eventSeq);
    }
  }
  /** Member-only features have nothing to talk to for an audience viewer (§6). Fail fast and say why. */
  assertMember(feature) {
    if (this.audienceRoom) {
      throw new SwalvoChatPermissionError(
        `${feature} are for conversation members; this is a live-stream audience token`,
        "NOT_A_MEMBER"
      );
    }
  }
  fetchEvents(room, afterEventSeq, limit) {
    return this.rest.request(`/v1/chat/conversations/${encodeURIComponent(room)}/events`, {
      query: { afterEventSeq, limit }
    });
  }
  /**
   * The event log no longer reaches this room's resume point. Re-read the
   * newest page of history and hand it to the app as the new truth.
   */
  async resyncRoom(room) {
    const page = await this.messages.listRaw({ room, limit: RESYNC_PAGE_SIZE });
    this.recovery.observeHistory(page.data);
    this.emit("resync", { roomId: room, page });
  }
  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit("connectionStateChanged", state);
  }
  send(type, payload) {
    if (!this.transport?.isOpen) {
      this.logger.debug(`dropped ${type}; not connected`);
      return;
    }
    this.transport.send({ type, ...payload });
  }
  /** Sends a frame and waits for its correlated ack, with a timeout. */
  request(type, payload) {
    if (!this.transport?.isOpen) {
      return Promise.reject(new SwalvoChatConnectionError("Not connected; call connect() first", "CONNECTION_CLOSED"));
    }
    const id = `r${++this.requestCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SwalvoChatConnectionError("The server did not respond in time", "TIMEOUT"));
      }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.transport.send({ type, id, ...payload });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  handleFrame(frame) {
    const type = String(frame.type);
    switch (type) {
      case "connected":
        this.onServerHello(frame);
        return;
      case "ack": {
        const request = this.takePending(frame.id);
        request?.resolve(frame.data);
        return;
      }
      case "error": {
        const error = toSwalvoChatError(frame.code, String(frame.message ?? "Chat request failed"), {
          retryAfterSeconds: frame.retryAfterSeconds,
          reason: frame.reason,
          scope: frame.scope
        });
        const request = this.takePending(frame.id);
        if (request) {
          request.reject(error);
          return;
        }
        if (error.code === "NOT_A_MEMBER" && typeof frame.room === "string") {
          this.onRemovedFromRoom(frame.room, "REMOVED");
        }
        this.emit("error", error);
        return;
      }
      case "room.joined":
      case "room.left": {
        const request = this.takePending(frame.id);
        if (request) {
          request.resolve(frame);
          return;
        }
        if (type === "room.left" && typeof frame.room === "string") {
          this.onRemovedFromRoom(frame.room, String(frame.reason ?? "REMOVED"));
        }
        return;
      }
      case "presence.count":
        this.emit("presenceCount", {
          roomId: String(frame.room ?? frame.roomId),
          online: Number(frame.online ?? 0)
        });
        return;
      case "message":
      case "message.updated":
      case "message.deleted":
      case "message.pinned":
      case "message.unpinned":
      case "reaction.added":
      case "reaction.removed":
      case "member.banned":
      case "member.unbanned":
      case "member.muted":
      case "member.unmuted":
        this.sequencer.ingest(roomOf(frame), frame);
        return;
      case "typing.started":
      case "typing.stopped":
        this.emit("typing", {
          userId: String(frame.userId),
          roomId: String(frame.roomId),
          isTyping: type === "typing.started"
        });
        return;
      case "presence":
        this.emit("presence", {
          userId: String(frame.userId),
          roomId: String(frame.roomId),
          status: frame.status,
          at: String(frame.at)
        });
        return;
      case "read":
        this.emit("read", {
          userId: String(frame.userId),
          roomId: String(frame.roomId),
          messageId: frame.messageId ?? null,
          at: String(frame.at)
        });
        return;
      case "pong":
        return;
      default:
        this.logger.debug(`ignoring unknown frame "${type}"`);
    }
  }
  /**
   * Applies one conversation event, live or replayed from the event log.
   * The sequencer has already decided it is new and in order.
   */
  dispatchConversationEvent(frame) {
    const type = String(frame.type);
    switch (type) {
      case "message":
        if (frame.message && typeof frame.message === "object") {
          this.onLiveMessage(normalizeMessage(frame.message));
        }
        return;
      case "message.updated":
        if (frame.message && typeof frame.message === "object") {
          this.emit("messageUpdated", normalizeMessage(frame.message), {
            reason: typeof frame.reason === "string" ? frame.reason : void 0
          });
        }
        return;
      case "message.deleted":
        this.emit("messageDeleted", {
          messageId: String(frame.messageId),
          roomId: String(frame.roomId ?? frame.room),
          deletedAt: String(frame.deletedAt),
          deletedBy: frame.deletedBy ?? null
        });
        return;
      case "message.pinned":
      case "message.unpinned": {
        const message = frame.message && typeof frame.message === "object" ? normalizeMessage(frame.message) : null;
        const event = {
          roomId: roomOf(frame),
          messageId: String(frame.messageId ?? message?.id ?? ""),
          message,
          by: frame.by ?? frame.pinnedBy ?? null,
          at: frame.at ?? frame.pinnedAt ?? null
        };
        this.emit(type === "message.pinned" ? "messagePinned" : "messageUnpinned", event);
        return;
      }
      case "reaction.added":
      case "reaction.removed": {
        const event = {
          messageId: String(frame.messageId),
          roomId: String(frame.roomId ?? frame.room),
          userId: String(frame.userId),
          emoji: String(frame.emoji),
          at: String(frame.at)
        };
        this.emit(type === "reaction.added" ? "reactionAdded" : "reactionRemoved", event);
        return;
      }
      case "member.banned":
      case "member.unbanned":
      case "member.muted":
      case "member.unmuted": {
        const event = {
          roomId: roomOf(frame),
          userId: String(frame.userId),
          by: frame.by ?? null,
          expiresAt: frame.expiresAt ?? null
        };
        const kind = type.slice("member.".length);
        if (event.userId === this.currentUserId) this.moderation.observe(kind, event);
        const name = {
          banned: "memberBanned",
          unbanned: "memberUnbanned",
          muted: "memberMuted",
          unmuted: "memberUnmuted"
        }[kind];
        this.emit(name, event);
        return;
      }
      default:
        this.logger.debug(`ignoring unknown conversation event "${type}"`);
    }
  }
  /**
   * The server removed this user from a room. Forget it entirely: re-joining
   * it on the next reconnect would only be refused, and every refusal is an
   * `error` the app has to explain.
   */
  onRemovedFromRoom(room, reason) {
    for (const alias of Array.from(this.desiredRooms)) {
      if (alias === room || this.roomAliases.get(alias) === room) {
        this.desiredRooms.delete(alias);
        this.roomAliases.delete(alias);
      }
    }
    this.recovery.forget(room);
    this.sequencer.forget(room);
    this.pendingLive.delete(room);
    if (reason === "BANNED") {
      this.moderation.observe("banned", { roomId: room, userId: this.currentUserId, by: null, expiresAt: null });
    }
    this.emit("removedFromRoom", { roomId: room, reason });
  }
  onServerHello(frame) {
    this.connectionId = frame.connectionId;
    const wasReconnecting = this.hasConnectedBefore;
    this.hasConnectedBefore = true;
    this.setState("connected");
    this.scheduleTokenRefresh(frame.expiresAt);
    this.connectPromise?.resolve();
    this.connectPromise = void 0;
    if (wasReconnecting) {
      const sequencedRooms = this.sequencedRoomsToSync();
      this.sequencer.beginSync(sequencedRooms);
      void this.syncRooms().then(() => {
        this.emit("reconnected");
        return this.recoverMissedMessages(sequencedRooms);
      }).catch((error) => {
        for (const room of sequencedRooms) void this.sequencer.catchUp(room);
        this.logger.warn(`reconnect handling failed: ${String(error)}`);
      }).finally(() => void this.outbox?.flush());
    } else {
      this.emit("connected");
    }
  }
  handleClose(info) {
    this.connectionId = void 0;
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new SwalvoChatConnectionError("Connection closed before the server replied", "CONNECTION_CLOSED"));
    }
    this.pending.clear();
    if (info.willReconnect) {
      this.setState("reconnecting");
      return;
    }
    this.setState(info.terminal ? "failed" : "disconnected");
    this.emit("disconnected");
    this.connectPromise?.reject(
      new SwalvoChatConnectionError(`Chat connection closed (${info.code})`, "CONNECTION_CLOSED")
    );
    this.connectPromise = void 0;
  }
  fail(error) {
    this.setState("failed");
    this.connectPromise?.reject(error);
    this.connectPromise = void 0;
    this.emit("error", error);
  }
  /**
   * Every live message goes through here rather than straight to the
   * application, for two reasons.
   *
   * **De-duplication.** A message can legitimately arrive twice: once over
   * the socket just before it dropped, and again in the catch-up that
   * re-reads that window from history. The application must see it once.
   *
   * **Ordering.** While a catch-up is replaying older messages, a live one
   * arriving would otherwise be delivered ahead of them, and a sender's
   * messages would reach the application out of order — which is the one
   * ordering guarantee Swalvo actually makes. So live messages are held
   * until the replay finishes, then flushed in arrival order.
   */
  onLiveMessage(message) {
    if (this.recovering) {
      const queued = this.pendingLive.get(message.roomId);
      if (queued) {
        queued.push(message);
      } else {
        this.pendingLive.set(message.roomId, [message]);
      }
      return;
    }
    if (this.recovery.accept(message)) {
      this.emit("message", message);
    }
  }
  /**
   * Replays what each room missed while this client was disconnected.
   *
   * Rooms are recovered concurrently and independently: they have separate
   * resume points, and one room failing — or being unreadable by this
   * token — must not hold up the others.
   *
   * Runs after `syncRooms()`, so the socket is already subscribed before
   * the catch-up starts. Anything that arrives during the catch-up is
   * buffered rather than dropped, which is what closes the window between
   * "history read" and "live again".
   */
  async recoverMissedMessages(sequencedRooms = []) {
    const rooms = Array.from(new Set(Array.from(this.desiredRooms).map((room) => this.resolveRoom(room)))).filter(
      (room) => this.recovery.has(room)
    );
    let perRoom = [];
    if (rooms.length === 0) {
      this.flushPendingLive();
    } else {
      this.recovering = true;
      try {
        perRoom = await Promise.all(rooms.map((room) => this.recovery.recoverRoom(room)));
      } finally {
        this.recovering = false;
        this.flushPendingLive();
      }
    }
    const eventResults = await Promise.all(
      sequencedRooms.map((room) => this.sequencer.catchUp(room))
    );
    const eventErrors = eventResults.filter((result) => result.error !== void 0);
    for (const result of eventErrors) {
      const existing = perRoom.find((entry) => entry.room === result.room);
      if (existing) {
        existing.error = existing.error ?? result.error;
      } else {
        perRoom.push({ room: result.room, recovered: 0, gap: false, error: result.error });
      }
    }
    const summary = {
      recovered: perRoom.reduce((total, result) => total + result.recovered, 0),
      events: eventResults.reduce((total, result) => total + result.applied, 0),
      resynced: eventResults.filter((result) => result.expired).map((result) => result.room),
      perRoom,
      gap: perRoom.some((result) => result.gap) || eventResults.some((result) => result.expired),
      errors: perRoom.filter((result) => result.error !== void 0)
    };
    if (summary.recovered > 0 || summary.events > 0 || summary.gap || summary.errors.length > 0) {
      this.logger.info(
        `recovered ${summary.recovered} missed message(s) and ${summary.events} event(s)` + (summary.gap ? " (with a gap)" : "") + (summary.errors.length > 0 ? `; ${summary.errors.length} room(s) incomplete` : "")
      );
    }
    this.emit("recovered", summary);
  }
  /** Rooms the caller still wants and the sequencer can resume. */
  sequencedRoomsToSync() {
    const wanted = new Set(Array.from(this.desiredRooms).map((room) => this.resolveRoom(room)));
    return this.sequencer.knownRooms().filter((room) => wanted.has(room));
  }
  /** Delivers messages that arrived mid-catch-up, in the order they came in. */
  flushPendingLive() {
    if (this.pendingLive.size === 0) return;
    const buffered = Array.from(this.pendingLive.values()).flat();
    this.pendingLive.clear();
    for (const message of buffered) {
      if (this.recovery.accept(message)) {
        this.emit("message", message);
      }
    }
  }
  async syncRooms() {
    if (this.desiredPresence) {
      this.send("presence.set", { status: this.desiredPresence });
    }
    for (const room of Array.from(this.desiredRooms)) {
      try {
        this.onJoined(room, await this.request("room.join", { room }));
      } catch (error) {
        this.emit("error", error instanceof SwalvoChatError ? error : toSwalvoChatError(void 0, String(error)));
      }
    }
  }
  /**
   * Refreshes the token shortly before it expires, assuming the app gave us
   * a way to fetch a new one. Without `onTokenExpiring` the socket just
   * closes at expiry. Correct, but abrupt, which is why this exists.
   */
  scheduleTokenRefresh(expiresAt) {
    this.clearTokenRefreshTimer();
    if (!this.config.onTokenExpiring) return;
    const expiry = expiresAt ? Date.parse(expiresAt) : this.tokenExpiresAt;
    const refreshAt = Math.max(expiry - 6e4, Date.now() + 5e3);
    this.tokenRefreshTimer = setTimeout(() => {
      void (async () => {
        try {
          const token = await this.config.onTokenExpiring();
          const payload = decodeChatToken(token);
          this.currentUserId = payload.sub;
          this.tokenExpiresAt = payload.exp * 1e3;
          this.rest.setToken(token);
          this.transport?.setToken(token);
          await this.reconnect();
        } catch (error) {
          this.emit(
            "error",
            error instanceof SwalvoChatError ? error : toSwalvoChatError("TOKEN_EXPIRED", "Could not refresh the chat token")
          );
        }
      })();
    }, refreshAt - Date.now());
  }
  clearTokenRefreshTimer() {
    if (this.tokenRefreshTimer !== void 0) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = void 0;
    }
  }
  takePending(id) {
    if (typeof id !== "string") return void 0;
    const request = this.pending.get(id);
    if (!request) return void 0;
    clearTimeout(request.timer);
    this.pending.delete(id);
    return request;
  }
};
function createChatClient(config) {
  return new ChatClient(validateConfig(config));
}
var MAX_MENTIONS = 50;
var RESYNC_PAGE_SIZE = 50;
function roomOf(frame) {
  const message = frame.message;
  return String(frame.roomId ?? frame.room ?? message?.roomId ?? "");
}
function generateClientMessageId() {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `cm_${random}`;
}

export { AttachmentsApi, CHAT_SDK_VERSION, ChatClient, Inbox, LocalStorageOutboxStorage, MemoryOutboxStorage, MessagesApi, ModerationApi, Outbox, RavenAttachmentError, RavenChatAuthenticationError, RavenChatConnectionError, RavenChatError, RavenChatPermissionError, RavenMessageBlockedError, RavenMessageError, RavenModerationError, RavenRateLimitError, RavenRoomError, RavenSlowModeError, SwalvoAttachmentError, SwalvoChatAuthenticationError, SwalvoChatConnectionError, SwalvoChatError, SwalvoChatPermissionError, SwalvoMessageBlockedError, SwalvoMessageError, SwalvoModerationError, SwalvoRateLimitError, SwalvoRoomError, SwalvoSlowModeError, compareSeq, createChatClient, isRavenChatError, isSwalvoChatError };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map