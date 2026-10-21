// src/errors.ts
var RTCError = class extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "RTCError";
    this.code = code;
    this.cause = cause;
  }
};
function isRTCError(value) {
  return value instanceof RTCError;
}

// src/config.ts
function decodeTokenPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new RTCError("INVALID_TOKEN", "RTC token is malformed (expected a JWT with 3 parts)");
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(atob(base64));
    return {
      roomId: typeof json?.rid === "string" ? json.rid : void 0,
      roomName: typeof json?.rnm === "string" ? json.rnm : void 0,
      exp: typeof json?.exp === "number" ? json.exp : void 0,
      sub: typeof json?.sub === "string" ? json.sub : void 0
    };
  } catch (error) {
    throw new RTCError("INVALID_TOKEN", "RTC token payload could not be decoded", error);
  }
}
function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new RTCError("INVALID_TOKEN", "createRTCClient(config) requires a configuration object");
  }
  if (!config.token || typeof config.token !== "string") {
    throw new RTCError("INVALID_TOKEN", "config.token is required; the RTC token from your backend");
  }
  if (config.refreshToken !== void 0 && typeof config.refreshToken !== "function") {
    throw new RTCError("INVALID_TOKEN", "config.refreshToken must be a function returning a Promise of a new RTC token");
  }
  if (!config.endpoint || typeof config.endpoint !== "string") {
    throw new RTCError(
      "INVALID_TOKEN",
      'config.endpoint is required; the "endpoint" field from the same token-mint response as config.token'
    );
  }
  const codec = config.videoCodec ?? config.preferredVideoCodec;
  if (codec !== void 0 && !["vp8", "h264", "vp9", "av1"].includes(codec)) {
    throw new RTCError("NOT_SUPPORTED", `config.videoCodec must be 'vp8', 'h264', 'vp9' or 'av1', not "${String(codec)}"`);
  }
  if (config.e2ee !== void 0 && !config.e2ee?.keyProvider) {
    throw new RTCError("E2EE_REQUIRED", "config.e2ee needs a keyProvider: createSharedKeyProvider(passphrase) or createKeyProvider()");
  }
  const { exp } = decodeTokenPayload(config.token);
  if (exp !== void 0 && exp * 1e3 <= Date.now()) {
    throw new RTCError("TOKEN_EXPIRED", "RTC token has already expired");
  }
  return {
    token: config.token,
    endpoint: config.endpoint,
    iceServers: config.iceServers,
    logLevel: config.logLevel ?? "silent",
    autoReconnect: config.autoReconnect ?? true,
    refreshToken: config.refreshToken,
    telemetryUrl: config.telemetryUrl,
    telemetry: config.telemetry ?? true,
    adaptiveStream: config.adaptiveStream ?? true,
    preferredVideoCodec: config.videoCodec ?? config.preferredVideoCodec,
    audioRed: config.audioRed ?? true,
    e2ee: config.e2ee,
    autoSubscribe: config.autoSubscribe ?? true
  };
}
function assertTokenMatchesRoom(token, room) {
  const { roomId, roomName } = decodeTokenPayload(token);
  if (!roomId && !roomName) {
    return;
  }
  if (room === roomId || room === roomName) {
    return;
  }
  const minted = roomName ?? roomId;
  throw new RTCError("ROOM_NOT_FOUND", `This token was minted for room "${minted}", not "${room}"`);
}

// src/logger.ts
var LEVELS = ["silent", "error", "warn", "info", "debug"];
function createLogger(level = "silent") {
  const rank = LEVELS.indexOf(level);
  const enabled = (l) => LEVELS.indexOf(l) <= rank;
  return {
    error: (...args) => {
      if (enabled("error")) console.error("[swalvo-rtc]", ...args);
    },
    warn: (...args) => {
      if (enabled("warn")) console.warn("[swalvo-rtc]", ...args);
    },
    info: (...args) => {
      if (enabled("info")) console.info("[swalvo-rtc]", ...args);
    },
    debug: (...args) => {
      if (enabled("debug")) console.debug("[swalvo-rtc]", ...args);
    }
  };
}

// src/internal/devices/enumerate.ts
async function listDevices(kind) {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    throw new RTCError(
      "NOT_SUPPORTED",
      "Device enumeration is not available in this environment (no navigator.mediaDevices)"
    );
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => !kind || device.kind === kind).map((device) => ({
    deviceId: device.deviceId,
    label: device.label,
    kind: device.kind
  }));
}

// src/internal/telemetry/track-stats.ts
var MS_PER_SECOND = 1e3;
function normalizeTrackStats(raw, previous, kind, direction) {
  const stats = { kind, direction };
  if (typeof raw.jitter === "number") {
    stats.jitterMs = raw.jitter * MS_PER_SECOND;
  }
  if (typeof raw.roundTripTime === "number") {
    stats.roundTripTimeMs = raw.roundTripTime * MS_PER_SECOND;
  }
  if (typeof raw.mimeType === "string") {
    stats.codec = raw.mimeType;
  }
  if (typeof raw.frameWidth === "number") stats.frameWidth = raw.frameWidth;
  if (typeof raw.frameHeight === "number") stats.frameHeight = raw.frameHeight;
  if (typeof raw.framesPerSecond === "number") stats.framesPerSecond = raw.framesPerSecond;
  if (typeof raw.packetsLost === "number") {
    stats.packetsLost = raw.packetsLost;
    const attempted = direction === "send" ? raw.packetsSent : raw.packetsReceived;
    if (typeof attempted === "number" && attempted + raw.packetsLost > 0) {
      stats.packetLossPercent = raw.packetsLost / (attempted + raw.packetsLost) * 100;
    }
  }
  const bytesField = direction === "send" ? "bytesSent" : "bytesReceived";
  const currentBytes = raw[bytesField];
  const previousBytes = previous?.[bytesField];
  if (typeof currentBytes === "number" && typeof previousBytes === "number") {
    const elapsedSeconds = (raw.timestamp - previous.timestamp) / MS_PER_SECOND;
    if (elapsedSeconds > 0 && currentBytes >= previousBytes) {
      stats.bitrateBps = (currentBytes - previousBytes) * 8 / elapsedSeconds;
    }
  }
  return stats;
}
function pickBestLayer(layers) {
  return layers.reduce((best, layer) => {
    const bestWidth = best?.frameWidth ?? -1;
    const layerWidth = layer.frameWidth ?? -1;
    return layerWidth > bestWidth ? layer : best;
  }, void 0);
}

// src/track.ts
function trackKindToMediaKind(kind) {
  switch (kind) {
    case "camera":
    case "screenShare":
      return "video";
    case "microphone":
    case "screenShareAudio":
      return "audio";
    case "unknown":
      return "unknown";
  }
}
var Track = class {
  constructor(delegate, kind) {
    this.delegate = delegate;
    this.kind = kind;
  }
  /** The underlying native track, for the rare occasion you need to go deeper. */
  get mediaStreamTrack() {
    return this.delegate.mediaStreamTrack;
  }
  get mediaStream() {
    return this.delegate.mediaStream;
  }
  get isMuted() {
    return this.delegate.isMuted;
  }
  /** Attaches this track to a `<video>`/`<audio>` element, creating one if omitted. */
  attach(element) {
    return this.delegate.attach(element);
  }
  /** Detaches this track from one element, or from all elements if omitted. */
  detach(element) {
    const result = this.delegate.detach(element);
    return Array.isArray(result) ? result : [result];
  }
};
var LocalTrack = class extends Track {
  constructor(delegate, kind) {
    super(delegate, kind);
    this.localDelegate = delegate;
  }
  async mute() {
    await this.localDelegate.mute();
  }
  async unmute() {
    await this.localDelegate.unmute();
  }
  /** Stops the underlying device capture. Publish state belongs to Room.unpublish(). */
  stop() {
    this.mediaStreamTrack.stop();
  }
  /**
   * Live send-side stats for this track: bitrate, packet loss, jitter, RTT
   * (audio only), resolution and fps (video only).
   *
   * You get `undefined`, not a zeroed-out object, when the adapter can't
   * supply them, either because the delegate has no `getSenderStats` or
   * because the underlying call resolved to nothing. The module doc covers
   * why that distinction matters.
   *
   * Call it periodically instead of once. `Room.getConnectionStats()` does,
   * every few seconds. Bitrate needs two samples to compute, so the first
   * call after a track starts always omits it.
   */
  async getStats() {
    const raw = await this.localDelegate.getSenderStats?.();
    if (!raw) {
      return void 0;
    }
    const sample = Array.isArray(raw) ? pickBestLayer(raw) : raw;
    if (!sample) {
      return void 0;
    }
    const stats = normalizeTrackStats(sample, this.lastSample, this.kind, "send");
    this.lastSample = sample;
    return stats;
  }
};
var RemoteTrack = class extends Track {
  constructor(delegate, kind) {
    super(delegate, kind);
    this._subscriptionState = "active";
    this._enabled = true;
    this.remoteDelegate = delegate;
  }
  /** @internal Wires this track to the adapter's layer control. */
  setLayerController(controller) {
    this.layerController = controller;
  }
  /**
   * Whether the SFU is forwarding this track to you. See
   * `TrackSubscriptionState`. Reported by the server; `'active'` against a
   * server that predates it. Changes arrive as the room's
   * `trackSubscriptionStateChanged` event.
   */
  get subscriptionState() {
    return this._subscriptionState;
  }
  /**
   * The video layer the SFU last said it is forwarding. Undefined for
   * audio, and until the server has said — which it never will if it
   * predates subscription-state reporting.
   */
  get layer() {
    return this._layer;
  }
  /** False after `setEnabled(false)`, until `setEnabled(true)`. */
  get isEnabled() {
    return this._enabled;
  }
  /**
   * Pauses (`false`) or resumes (`true`) this video at the SFU without
   * unsubscribing. While disabled nothing is forwarded to you, so it costs
   * no bandwidth and no decoding, and resuming needs no renegotiation —
   * just a keyframe, a fraction of a second.
   *
   * Stronger than everything else that picks a layer: neither adaptive
   * streaming nor an earlier `setLayer()` turns a disabled track back on.
   * `setEnabled(true)` restores whichever of those was in effect. A no-op
   * on audio, which the SFU always forwards.
   */
  setEnabled(enabled) {
    if (this.kind === "microphone") return;
    this._enabled = enabled;
    this.layerController?.setEnabled?.(enabled);
  }
  /**
   * Tells adaptive streaming whether this video is on screen, for
   * renderers the SDK cannot observe itself: React Native views, a canvas
   * or WebGL texture fed from `mediaStreamTrack`. A browser `<video>`
   * passed to `attach()` needs none of this; its visibility is observed
   * directly.
   *
   * `false` pauses the track at the SFU after a short debounce (so a tile
   * flicking past during a scroll costs nothing), `true` resumes it at
   * once. Ignored when `adaptiveStream` is off, and overridden by
   * `setEnabled(false)` and by a pinned `setLayer()`. One flag per track:
   * if the same track is shown in two places, report from one of them.
   */
  setVisible(visible) {
    this.layerController?.setVisible?.(visible);
  }
  /** @internal Applied by the adapter from `subscription.state`. Returns whether anything changed. */
  _setSubscriptionState(state, layer) {
    if (this._subscriptionState === state && this._layer === layer) {
      return false;
    }
    this._subscriptionState = state;
    this._layer = layer;
    return true;
  }
  /**
   * Asks the SFU for a particular simulcast layer of this track.
   *
   * A preference, not a command: the SFU will not hand over a layer the
   * publisher is not sending, and congestion control may hold you below
   * what you asked for.
   *
   * # Precedence
   *
   * Calling this **pins** the track — adaptive streaming will not move it
   * afterwards, so your choice is not quietly undone the next time the
   * element is resized. Pass `'auto'` to release the pin and hand the track
   * back to adaptive streaming (or, with adaptive streaming off, back to
   * the SFU's own choice).
   *
   * Works whether or not `adaptiveStream` is enabled.
   */
  setLayer(layer) {
    this.layerController?.request(layer);
  }
  /**
   * Attaches, and starts sizing the subscription to the element.
   *
   * This is what makes `adaptiveStream` work without an application doing
   * anything: the element you render into is the only honest measure of how
   * much resolution this track actually needs.
   */
  attach(element) {
    const target = super.attach(element);
    this.layerController?.observe(target);
    return target;
  }
  detach(element) {
    const detached = super.detach(element);
    for (const el of detached) {
      this.layerController?.unobserve(el);
    }
    return detached;
  }
  /** Live receive-side stats. `LocalTrack.getStats()` covers the shape and the caveats. */
  async getStats() {
    const raw = await this.remoteDelegate.getReceiverStats?.();
    if (!raw) {
      return void 0;
    }
    const stats = normalizeTrackStats(raw, this.lastSample, this.kind, "receive");
    this.lastSample = raw;
    return stats;
  }
};

// src/internal/media/errors.ts
function toMediaError(error, kind) {
  const name = errorName(error);
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new RTCError(permissionDeniedCode(kind), `Permission to use the ${label(kind)} was denied`, error);
    case "NotFoundError":
    case "OverconstrainedError":
      return new RTCError("DEVICE_NOT_FOUND", `No ${label(kind)} device matched`, error);
    case "NotReadableError":
      return new RTCError("MEDIA_ERROR", `The ${label(kind)} is already in use by another application`, error);
    case "AbortError":
      return new RTCError("MEDIA_ERROR", `Capturing the ${label(kind)} was aborted`, error);
    case "TypeError":
      return new RTCError("MEDIA_ERROR", `Invalid ${label(kind)} capture constraints`, error);
    default:
      return new RTCError("MEDIA_ERROR", `Could not access the ${label(kind)}`, error);
  }
}
function errorName(error) {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name;
  }
  if (error && typeof error === "object" && typeof error.name === "string") {
    return error.name;
  }
  return void 0;
}
function label(kind) {
  return kind === "screenShare" ? "screen" : kind;
}
function permissionDeniedCode(kind) {
  if (kind === "camera") return "CAMERA_PERMISSION_DENIED";
  if (kind === "microphone") return "MICROPHONE_PERMISSION_DENIED";
  return "PERMISSION_DENIED";
}

// src/internal/telemetry/rtc-stats.ts
function rawStatsFromReport(report, wanted) {
  const codecs = /* @__PURE__ */ new Map();
  const remoteInbound = [];
  const rtpEntries = [];
  report.forEach((entry) => {
    const stats = entry;
    switch (stats.type) {
      case "codec":
        if (typeof stats.id === "string" && typeof stats.mimeType === "string") {
          codecs.set(stats.id, stats.mimeType);
        }
        break;
      case "remote-inbound-rtp":
        remoteInbound.push(stats);
        break;
      case wanted:
        rtpEntries.push(stats);
        break;
    }
  });
  return rtpEntries.map((rtp) => toRawStats(rtp, wanted, codecs, remoteInbound));
}
function toRawStats(rtp, direction, codecs, remoteInbound) {
  const kind = rtp.kind ?? rtp.mediaType;
  const sample = {
    type: kind === "audio" ? "audio" : kind === "video" ? "video" : void 0,
    // `RTCStats.timestamp` is a DOMHighResTimeStamp relative to the time
    // origin, and `normalizeTrackStats` only ever uses it as a delta
    // against a previous sample, so the epoch is irrelevant. Falling back
    // to Date.now() keeps the delta usable on the rare browser that omits
    // it.
    timestamp: typeof rtp.timestamp === "number" ? rtp.timestamp : Date.now()
  };
  if (typeof rtp.jitter === "number") sample.jitter = rtp.jitter;
  if (typeof rtp.frameWidth === "number") sample.frameWidth = rtp.frameWidth;
  if (typeof rtp.frameHeight === "number") sample.frameHeight = rtp.frameHeight;
  if (typeof rtp.framesPerSecond === "number") sample.framesPerSecond = rtp.framesPerSecond;
  const mimeType = rtp.mimeType ?? (rtp.codecId ? codecs.get(rtp.codecId) : void 0);
  if (mimeType) sample.mimeType = mimeType;
  if (direction === "outbound-rtp") {
    if (typeof rtp.bytesSent === "number") sample.bytesSent = rtp.bytesSent;
    if (typeof rtp.packetsSent === "number") sample.packetsSent = rtp.packetsSent;
    const feedback = remoteInbound.find((remote) => rtp.id && remote.localId === rtp.id) ?? remoteInbound.find((remote) => rtp.ssrc !== void 0 && remote.ssrc === rtp.ssrc);
    if (feedback) {
      if (typeof feedback.roundTripTime === "number") sample.roundTripTime = feedback.roundTripTime;
      if (typeof feedback.packetsLost === "number") sample.packetsLost = feedback.packetsLost;
      if (sample.jitter === void 0 && typeof feedback.jitter === "number") {
        sample.jitter = feedback.jitter;
      }
    }
    return sample;
  }
  if (typeof rtp.bytesReceived === "number") sample.bytesReceived = rtp.bytesReceived;
  if (typeof rtp.packetsReceived === "number") sample.packetsReceived = rtp.packetsReceived;
  if (typeof rtp.packetsLost === "number") sample.packetsLost = rtp.packetsLost;
  return sample;
}
async function connectionRoundTripTimeMs(connection) {
  const report = await connection.getStats();
  let rttSeconds;
  report.forEach((entry) => {
    const stats = entry;
    if (stats.type !== "candidate-pair") {
      return;
    }
    if (stats.state !== "succeeded" || stats.nominated !== true) {
      return;
    }
    if (typeof stats.currentRoundTripTime === "number") {
      rttSeconds = stats.currentRoundTripTime;
    }
  });
  return rttSeconds === void 0 ? void 0 : rttSeconds * 1e3;
}

// src/internal/media/native-track.ts
var NativeTrackDelegate = class {
  constructor(mediaStreamTrack) {
    this.attachedElements = /* @__PURE__ */ new Set();
    this.mediaStreamTrack = mediaStreamTrack;
  }
  get mediaStream() {
    if (!this.stream && typeof MediaStream !== "undefined") {
      this.stream = new MediaStream([this.mediaStreamTrack]);
    }
    return this.stream;
  }
  attach(element) {
    const target = element ?? this.createElement();
    const stream = this.mediaStream;
    if (stream) {
      target.srcObject = stream;
    }
    target.autoplay = true;
    if (target instanceof HTMLVideoElement) {
      target.playsInline = true;
    }
    this.attachedElements.add(target);
    return target;
  }
  detach(element) {
    if (element) {
      element.srcObject = null;
      this.attachedElements.delete(element);
      return element;
    }
    const detached = Array.from(this.attachedElements);
    for (const attached of detached) {
      attached.srcObject = null;
    }
    this.attachedElements.clear();
    return detached;
  }
  /**
   * Swaps out the track this delegate wraps.
   *
   * Called once `replaceTrack` on the sender has succeeded, so attached
   * elements and `mediaStreamTrack` describe what's actually going out
   * rather than the track we just replaced.
   */
  swapMediaStreamTrack(next) {
    this.mediaStreamTrack = next;
    this.stream = typeof MediaStream !== "undefined" ? new MediaStream([next]) : void 0;
    const stream = this.stream;
    if (!stream) {
      return;
    }
    for (const element of this.attachedElements) {
      element.srcObject = stream;
    }
  }
  createElement() {
    if (typeof document === "undefined") {
      throw new Error("attach() without an element requires a DOM");
    }
    return document.createElement(this.mediaStreamTrack.kind === "video" ? "video" : "audio");
  }
};
var NativeLocalTrackDelegate = class extends NativeTrackDelegate {
  constructor() {
    super(...arguments);
    this.muted = false;
  }
  get isMuted() {
    return this.muted;
  }
  /** @internal Called by the adapter once the track has a sender. */
  setSender(sender) {
    this.sender = sender;
  }
  /**
   * Mutes by disabling the underlying track, not by removing it.
   *
   * `track.enabled = false` has the browser send silence or black frames.
   * The RTP stream keeps going, the transceiver stays put, and unmuting is
   * instant. Stopping the track instead releases the device, which does
   * turn the camera light off (users read that as "off"), but undoing it
   * then costs a fresh `getUserMedia` and a renegotiation.
   *
   * We tell the SFU separately over signaling, so it can stop forwarding
   * the silence to every subscriber instead of paying to relay nothing.
   */
  async mute() {
    this.mediaStreamTrack.enabled = false;
    this.muted = true;
    return void 0;
  }
  async unmute() {
    this.mediaStreamTrack.enabled = true;
    this.muted = false;
    return void 0;
  }
  /**
   * Replaces the outgoing track without renegotiating.
   *
   * This is the trick that makes Swalvo Effects work mid-call.
   * `RTCRtpSender.replaceTrack` swaps the source of an established stream,
   * so a processed video track takes over from the raw camera with no
   * offer/answer and nobody else in the room noticing.
   */
  async replaceTrack(track, _userProvidedTrack) {
    if (this.sender) {
      await this.sender.replaceTrack(track);
    }
    this.swapMediaStreamTrack(track);
    if (this.muted) {
      track.enabled = false;
    }
    return void 0;
  }
  /**
   * Send-side stats for this track.
   *
   * Video gets an array, because a simulcast sender reports one
   * `outbound-rtp` per encoding layer, and `LocalTrack.getStats()` picks
   * the highest-resolution one. You get `undefined` when there's no sender
   * yet. An unpublished track has no send statistics, and reporting zeroes
   * would claim it was sending nothing when really it isn't sending.
   */
  async getSenderStats() {
    if (!this.sender) {
      return void 0;
    }
    const report = await this.sender.getStats();
    const samples = rawStatsFromReport(report, "outbound-rtp");
    if (samples.length === 0) {
      return void 0;
    }
    return samples.length === 1 ? samples[0] : samples;
  }
};
var NativeRemoteTrackDelegate = class extends NativeTrackDelegate {
  constructor(mediaStreamTrack, receiver) {
    super(mediaStreamTrack);
    this.publisherMuted = false;
    this.receiver = receiver;
  }
  get isMuted() {
    return this.publisherMuted;
  }
  /** @internal Set from the SFU's `track.muted` / `track.unmuted` events. */
  setPublisherMuted(muted) {
    this.publisherMuted = muted;
  }
  async getReceiverStats() {
    const report = await this.receiver.getStats();
    const [sample] = rawStatsFromReport(report, "inbound-rtp");
    return sample;
  }
};

// src/internal/media/capture.ts
var DEFAULT_AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
};
var DEFAULT_VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 }
};
var VIDEO_PROFILES = {
  "360p": { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
  "480p": { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  "720p": { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  "1080p": { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
};
async function createCameraTrack(options = {}) {
  const constraints = {
    ...DEFAULT_VIDEO_CONSTRAINTS,
    ...options.profile ? VIDEO_PROFILES[options.profile] : {},
    ...options.facingMode ? { facingMode: options.facingMode } : {},
    ...options.deviceId ? { deviceId: { exact: options.deviceId } } : {},
    ...options.constraints
  };
  const stream = await getUserMedia({ video: constraints, audio: false }, "camera");
  return trackFromStream(stream, "camera");
}
async function createMicrophoneTrack(options = {}) {
  const constraints = {
    ...DEFAULT_AUDIO_CONSTRAINTS,
    ...options.deviceId ? { deviceId: { exact: options.deviceId } } : {},
    ...options.constraints
  };
  const stream = await getUserMedia({ audio: constraints, video: false }, "microphone");
  return trackFromStream(stream, "microphone");
}
async function createScreenShareTrack() {
  return (await createScreenShareTracks()).video;
}
async function createScreenShareTracks(options = {}) {
  const wantAudio = options.audio === true;
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw new RTCError("NOT_SUPPORTED", "Screen sharing is not available on this platform (no getDisplayMedia)");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: wantAudio });
  } catch (error) {
    throw toMediaError(error, "screenShare");
  }
  const [videoTrack] = stream.getVideoTracks();
  const [audioTrack] = wantAudio && typeof stream.getAudioTracks === "function" ? stream.getAudioTracks() : [];
  if (!videoTrack) {
    audioTrack?.stop();
    throw new RTCError("MEDIA_ERROR", "Screen capture returned no video track");
  }
  return {
    video: new LocalTrack(new NativeLocalTrackDelegate(videoTrack), "screenShare"),
    audio: audioTrack ? new LocalTrack(new NativeLocalTrackDelegate(audioTrack), "screenShareAudio") : void 0
  };
}
function createCustomTrack(mediaStreamTrack, options = {}) {
  if (!mediaStreamTrack || typeof mediaStreamTrack !== "object" || typeof mediaStreamTrack.kind !== "string") {
    throw new RTCError("MEDIA_ERROR", "createCustomTrack() needs a MediaStreamTrack");
  }
  if (mediaStreamTrack.kind !== "audio" && mediaStreamTrack.kind !== "video") {
    throw new RTCError("MEDIA_ERROR", `A MediaStreamTrack of kind "${mediaStreamTrack.kind}" cannot be published`);
  }
  if (mediaStreamTrack.readyState === "ended") {
    throw new RTCError("MEDIA_ERROR", "This MediaStreamTrack has already ended");
  }
  const source = options.source ?? (mediaStreamTrack.kind === "audio" ? "microphone" : "camera");
  const audioSource = source === "microphone" || source === "screenShareAudio";
  if (audioSource && mediaStreamTrack.kind !== "audio") {
    throw new RTCError("MEDIA_ERROR", `A ${source} track has to be an audio MediaStreamTrack`);
  }
  if (!audioSource && mediaStreamTrack.kind !== "video") {
    throw new RTCError("MEDIA_ERROR", `A ${source} track has to be a video MediaStreamTrack`);
  }
  return new LocalTrack(new NativeLocalTrackDelegate(mediaStreamTrack), source);
}
async function getUserMedia(constraints, kind) {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new RTCError(
      "NOT_SUPPORTED",
      "Media capture is not available in this environment (no navigator.mediaDevices)"
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    throw toMediaError(error, kind);
  }
}
function trackFromStream(stream, kind) {
  const [track] = kind === "microphone" ? stream.getAudioTracks() : stream.getVideoTracks();
  if (!track) {
    throw new RTCError("MEDIA_ERROR", `Capture returned no ${kind} track`);
  }
  return new LocalTrack(new NativeLocalTrackDelegate(track), kind);
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
    return this;
  }
  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
    return this;
  }
  once(event, handler) {
    const wrapped = ((...args) => {
      this.off(event, wrapped);
      handler(...args);
    });
    return this.on(event, wrapped);
  }
  removeAllListeners(event) {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
    return this;
  }
  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of Array.from(set)) {
      handler(...args);
    }
  }
};

// src/transcription.ts
var AGENT_IDENTITY_PREFIX = "agent-";
var TRANSCRIBER_IDENTITY_PREFIX = "transcriber-";
function isAgentIdentity(identity) {
  return identity.startsWith(AGENT_IDENTITY_PREFIX);
}
function isTranscriberIdentity(identity) {
  return identity.startsWith(TRANSCRIBER_IDENTITY_PREFIX);
}
var AGENT_STATES = /* @__PURE__ */ new Set(["listening", "thinking", "speaking", "ended"]);
var TRANSCRIPTION_STATUSES = /* @__PURE__ */ new Set(["STARTING", "ACTIVE", "STOPPING", "ENDED", "FAILED"]);
var isStr = (v) => typeof v === "string";
var isNum = (v) => typeof v === "number" && Number.isFinite(v);
function parseTranscriptionSegment(raw) {
  if (!isStr(raw.participantId) || !isStr(raw.segmentId) || !isStr(raw.text) || typeof raw.final !== "boolean") {
    return void 0;
  }
  return {
    type: "transcription.segment",
    transcriptionId: isStr(raw.transcriptionId) ? raw.transcriptionId : null,
    ...isStr(raw.agentId) ? { agentId: raw.agentId } : {},
    participantId: raw.participantId,
    segmentId: raw.segmentId,
    text: raw.text,
    final: raw.final,
    language: isStr(raw.language) ? raw.language : "",
    startMs: isNum(raw.startMs) ? raw.startMs : 0,
    endMs: isNum(raw.endMs) ? raw.endMs : 0
  };
}
function parseTranscriptionState(raw) {
  if (!isStr(raw.transcriptionId) || !isStr(raw.status) || !TRANSCRIPTION_STATUSES.has(raw.status)) {
    return void 0;
  }
  return {
    transcriptionId: raw.transcriptionId,
    status: raw.status,
    language: isStr(raw.language) ? raw.language : ""
  };
}
function parseAgentState(value) {
  return isStr(value) && AGENT_STATES.has(value) ? value : void 0;
}
var EMPTY_SNAPSHOT = Object.freeze({ segments: [], interim: {}, active: false });
var CaptionStore = class {
  constructor(options = {}) {
    this.snapshot = EMPTY_SNAPSHOT;
    /** Open interims by segmentId, in arrival order of their first update. */
    this.open = /* @__PURE__ */ new Map();
    this.listeners = /* @__PURE__ */ new Set();
    this.getSnapshot = () => this.snapshot;
    this.subscribe = (listener) => {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    };
    this.maxSegments = Math.max(1, Math.floor(options.maxSegments ?? 100));
    this.participantId = options.participantId;
  }
  /** Listens to a room's caption events. Returns the detach function. */
  attach(source) {
    const onSegment = (segment) => this.applySegment(segment);
    const onState = (state) => this.applyState(state);
    const offSegment = source.on("transcriptionSegment", onSegment);
    const offState = source.on("transcriptionStateChanged", onState);
    return () => {
      if (typeof offSegment === "function") offSegment();
      else source.off?.("transcriptionSegment", onSegment);
      if (typeof offState === "function") offState();
      else source.off?.("transcriptionStateChanged", onState);
    };
  }
  /** Applies one segment. Returns whether the snapshot changed. */
  applySegment(segment) {
    if (this.participantId !== void 0 && segment.participantId !== this.participantId) {
      return false;
    }
    let segments = this.snapshot.segments;
    if (segment.final) {
      const hadInterim = this.open.delete(segment.segmentId);
      if (segment.text.trim() === "") {
        if (!hadInterim) return false;
      } else {
        segments = [...segments, segment];
        if (segments.length > this.maxSegments) segments = segments.slice(segments.length - this.maxSegments);
      }
    } else {
      this.open.set(segment.segmentId, segment);
    }
    const active = segment.transcriptionId !== null && !this.snapshot.active && !isEnded(this.snapshot.state) ? true : this.snapshot.active;
    this.publish({ ...this.snapshot, segments, interim: this.buildInterim(), active });
    return true;
  }
  /** Applies a `transcription.state`. An ended or failed transcription drops any interim left open. */
  applyState(state) {
    const active = state.status === "STARTING" || state.status === "ACTIVE";
    let interim = this.snapshot.interim;
    if (isEnded(state)) {
      for (const [id, seg] of this.open) {
        if (seg.transcriptionId !== null) this.open.delete(id);
      }
      interim = this.buildInterim();
    }
    this.publish({ ...this.snapshot, interim, active, state });
    return true;
  }
  /** Forgets every segment (finals and interims). The transcription state is kept. */
  clear() {
    this.open.clear();
    this.publish({ ...this.snapshot, segments: [], interim: {} });
  }
  buildInterim() {
    const interim = {};
    for (const seg of this.open.values()) interim[seg.participantId] = seg;
    return interim;
  }
  publish(next) {
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
};
function isEnded(state) {
  return state?.status === "ENDED" || state?.status === "FAILED" || state?.status === "STOPPING";
}

// src/participant.ts
var MAX_METADATA_BYTES = 4096;
var MAX_ATTRIBUTES = 32;
var MAX_ATTRIBUTE_KEY_LENGTH = 64;
var MAX_ATTRIBUTE_VALUE_BYTES = 1024;
var Participant = class extends TypedEventEmitter {
  constructor(identity, metadata, attributes) {
    super();
    this._isSpeaking = false;
    this._audioLevel = 0;
    this._connectionQuality = "unknown";
    this._attributes = {};
    this._identity = identity;
    this._metadata = metadata;
    this._attributes = { ...attributes ?? {} };
  }
  /**
   * Opaque application metadata (at most 4 KiB). Starts from the RTC
   * token's `metadata` and changes live: see `metadataChanged` and the
   * room's `participantMetadataChanged`.
   */
  get metadata() {
    return this._metadata;
  }
  /** Key/value attributes (at most 32 keys). A copy: mutating it changes nothing. */
  get attributes() {
    return { ...this._attributes };
  }
  /**
   * @internal Applied by the adapter from `room.joined`,
   * `participant.joined` and `participant.updated`. Fields left
   * `undefined` are kept. Returns the previous values when anything
   * changed, and emits `metadataChanged`; otherwise `undefined`.
   */
  _applyMetadata(update) {
    const prev = { metadata: this._metadata, attributes: { ...this._attributes } };
    let changed = false;
    if (update.metadata !== void 0) {
      const next = update.metadata ?? void 0;
      if (next !== this._metadata) {
        this._metadata = next;
        changed = true;
      }
    }
    if (update.attributes !== void 0) {
      const next = sanitizeAttributes(update.attributes);
      if (!sameAttributes(next, this._attributes)) {
        this._attributes = next;
        changed = true;
      }
    }
    if (!changed) {
      return void 0;
    }
    this.emit("metadataChanged", prev);
    return prev;
  }
  /** The RTC token's participant identity. Stable for the whole session. */
  get identity() {
    return this._identity;
  }
  /** Whether this is an AI voice agent the platform put in the room (identity `agent-…`). */
  get isAgent() {
    return isAgentIdentity(this._identity);
  }
  /** Whether this is the platform's transcriber (identity `transcriber-…`). It publishes nothing. */
  get isTranscriber() {
    return isTranscriberIdentity(this._identity);
  }
  /**
   * An agent's latest state from `agent.state`, or `undefined` before the
   * first one (and always for a participant that is not an agent).
   */
  get agentState() {
    return this._agentState;
  }
  /** @internal Applied by the adapter from `agent.state`. Returns whether it changed. */
  _setAgentState(state) {
    if (this._agentState === state) {
      return false;
    }
    this._agentState = state;
    this.emit("agentStateChanged", state);
    return true;
  }
  /**
   * Whether the SFU currently counts this participant as an active
   * speaker. Measured server-side from the audio they publish (RFC 6464
   * levels), so it is the same answer for everyone in the room. Always
   * false against a server that predates active-speaker detection.
   */
  get isSpeaking() {
    return this._isSpeaking;
  }
  /**
   * Smoothed audio level, 0..1, as of the last speaker update. Only
   * updated while the participant is among the active speakers; anyone
   * else reads 0. It is not a VU meter: updates arrive at most every
   * 300 ms, when the speaker set changes.
   */
  get audioLevel() {
    return this._audioLevel;
  }
  /**
   * The SFU's score for this participant's connection: loss, jitter and
   * RTT on what they send, and for a subscriber the bandwidth estimate
   * against what their subscriptions need. `'unknown'` until the server
   * has scored them, and always against a server that does not score.
   */
  get connectionQuality() {
    return this._connectionQuality;
  }
  /**
   * @internal Called once by the SFU adapter just after connect() resolves.
   * The constructor runs before the server has confirmed identity, so this
   * patches it in afterwards.
   */
  _setIdentity(identity) {
    this._identity = identity;
  }
  /** @internal Applied by the adapter from `speakers.changed`. Returns whether `isSpeaking` flipped. */
  _setSpeaking(speaking, level) {
    this._audioLevel = speaking ? clampLevel(level) : 0;
    if (this._isSpeaking === speaking) {
      return false;
    }
    this._isSpeaking = speaking;
    this.emit("isSpeakingChanged", speaking);
    return true;
  }
  /** @internal Applied by the adapter from `quality.changed`. Returns whether it changed. */
  _setConnectionQuality(quality) {
    if (this._connectionQuality === quality) {
      return false;
    }
    this._connectionQuality = quality;
    this.emit("connectionQualityChanged", quality);
    return true;
  }
};
function sanitizeAttributes(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
function sameAttributes(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}
function clampLevel(level) {
  if (!Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}
var LocalParticipant = class extends Participant {
  constructor() {
    super(...arguments);
    /** Tracks this participant has published, in publish order. Mutated by Room. */
    this.tracks = [];
  }
  /** @internal Wired by the SFU adapter. */
  _setUpdater(updater) {
    this.updater = updater;
  }
  /**
   * Replaces this participant's metadata for everyone in the room
   * (phase7-contracts §2). Needs the token grant `updateOwnMetadata`;
   * throws `PERMISSION_DENIED` without it, and `INVALID_ARGUMENT` over
   * 4 KiB. `metadata` updates when the server echoes the change
   * (`metadataChanged`), not optimistically.
   */
  async setMetadata(metadata) {
    if (typeof metadata !== "string") {
      throw new RTCError("INVALID_ARGUMENT", "metadata must be a string");
    }
    if (utf8Length(metadata) > MAX_METADATA_BYTES) {
      throw new RTCError("INVALID_ARGUMENT", `metadata is over the ${MAX_METADATA_BYTES}-byte limit`);
    }
    this.requireUpdater().sendUpdate({ metadata });
  }
  /**
   * Sets attributes for everyone in the room. Merged by the server: keys
   * given here are replaced, others kept. Same grant and echo rules as
   * `setMetadata()`. Limits: 32 keys, 64-character keys, 1 KiB values.
   */
  async setAttributes(attributes) {
    if (!attributes || typeof attributes !== "object") {
      throw new RTCError("INVALID_ARGUMENT", "attributes must be an object of strings");
    }
    const entries = Object.entries(attributes);
    if (entries.length > MAX_ATTRIBUTES) {
      throw new RTCError("INVALID_ARGUMENT", `At most ${MAX_ATTRIBUTES} attributes are allowed`);
    }
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
        throw new RTCError("INVALID_ARGUMENT", `Attribute keys must be 1-${MAX_ATTRIBUTE_KEY_LENGTH} characters`);
      }
      if (typeof value !== "string") {
        throw new RTCError("INVALID_ARGUMENT", `Attribute "${key}" must be a string`);
      }
      if (utf8Length(value) > MAX_ATTRIBUTE_VALUE_BYTES) {
        throw new RTCError("INVALID_ARGUMENT", `Attribute "${key}" is over the ${MAX_ATTRIBUTE_VALUE_BYTES}-byte limit`);
      }
    }
    this.requireUpdater().sendUpdate({ attributes: { ...attributes } });
  }
  requireUpdater() {
    const updater = this.updater;
    if (!updater) {
      throw new RTCError("CONNECTION_FAILED", "Not connected to a room");
    }
    if (!updater.canUpdateMetadata()) {
      throw new RTCError(
        "PERMISSION_DENIED",
        "The token does not grant updateOwnMetadata; mint it with perms.updateOwnMetadata: true"
      );
    }
    return updater;
  }
};
function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}
var RemoteParticipant = class extends Participant {
  constructor() {
    super(...arguments);
    /** Tracks subscribed from this participant, in subscribe order. Mutated by Room. */
    this.tracks = [];
  }
};

// src/internal/data-envelope.ts
var DATA_MAGIC = 82;
var DATA_VERSION_CLIENT = 2;
var DATA_VERSION_DELIVERY = 3;
var MAX_TOPIC_BYTES = 255;
var MAX_DESTINATIONS = 64;
var MAX_IDENTITY_BYTES = 255;
var MAX_RELIABLE_PAYLOAD_BYTES = 64 * 1024;
var MAX_LOSSY_PAYLOAD_BYTES = 1200;
var DataEnvelopeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DataEnvelopeError";
  }
};
var encoder = new TextEncoder();
function utf8(value) {
  return encoder.encode(value);
}
function encodeDataEnvelope(payload, options = {}) {
  const topic = utf8(options.topic ?? "");
  if (topic.byteLength > MAX_TOPIC_BYTES) {
    throw new DataEnvelopeError(`Topic is ${topic.byteLength} bytes; the limit is ${MAX_TOPIC_BYTES}`);
  }
  const destinations = options.destinationIdentities ?? [];
  if (destinations.length > MAX_DESTINATIONS) {
    throw new DataEnvelopeError(`${destinations.length} destinations; the limit is ${MAX_DESTINATIONS}`);
  }
  const ids = destinations.map((identity) => {
    const bytes2 = utf8(identity);
    if (bytes2.byteLength === 0 || bytes2.byteLength > MAX_IDENTITY_BYTES) {
      throw new DataEnvelopeError(`Destination identity must be 1-${MAX_IDENTITY_BYTES} bytes`);
    }
    return bytes2;
  });
  const size = 4 + topic.byteLength + 1 + ids.reduce((sum, id) => sum + 1 + id.byteLength, 0) + payload.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  out[offset++] = DATA_MAGIC;
  out[offset++] = DATA_VERSION_CLIENT;
  out[offset++] = 0;
  out[offset++] = topic.byteLength;
  out.set(topic, offset);
  offset += topic.byteLength;
  out[offset++] = ids.length;
  for (const id of ids) {
    out[offset++] = id.byteLength;
    out.set(id, offset);
    offset += id.byteLength;
  }
  out.set(payload, offset);
  return out;
}
function decodeDataMessage(bytes2) {
  const legacy = { legacy: true, payload: bytes2 };
  if (bytes2.byteLength < 2 || bytes2[0] !== DATA_MAGIC || bytes2[1] !== DATA_VERSION_DELIVERY) {
    return legacy;
  }
  let offset = 2;
  const readString = () => {
    if (offset >= bytes2.byteLength) return void 0;
    const length = bytes2[offset++];
    if (offset + length > bytes2.byteLength) return void 0;
    const slice = bytes2.subarray(offset, offset + length);
    offset += length;
    return decodeUtf8Strict(slice);
  };
  const senderIdentity = readString();
  if (senderIdentity === void 0) return legacy;
  const topic = readString();
  if (topic === void 0) return legacy;
  return { legacy: false, senderIdentity, topic, payload: bytes2.subarray(offset) };
}
function decodeUtf8Strict(bytes2) {
  let out = "";
  let i = 0;
  while (i < bytes2.length) {
    const b0 = bytes2[i];
    let cp;
    let need;
    let min;
    if (b0 < 128) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 194 && b0 <= 223) {
      cp = b0 & 31;
      need = 1;
      min = 128;
    } else if (b0 >= 224 && b0 <= 239) {
      cp = b0 & 15;
      need = 2;
      min = 2048;
    } else if (b0 >= 240 && b0 <= 244) {
      cp = b0 & 7;
      need = 3;
      min = 65536;
    } else {
      return void 0;
    }
    if (i + need >= bytes2.length) return void 0;
    for (let k = 1; k <= need; k++) {
      const b = bytes2[i + k];
      if ((b & 192) !== 128) return void 0;
      cp = cp << 6 | b & 63;
    }
    if (cp < min || cp > 1114111 || cp >= 55296 && cp <= 57343) return void 0;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

// src/internal/media/adaptive-stream.ts
var ADAPTIVE_LOW_THRESHOLD = 240;
var ADAPTIVE_HIGH_THRESHOLD = 640;
var ADAPTIVE_HYSTERESIS = 1.2;
var ADAPTIVE_DEBOUNCE_MS = 250;
var ADAPTIVE_PAUSE_DELAY_MS = 500;
function layerForWidth(width, current) {
  const plain = () => {
    if (width < ADAPTIVE_LOW_THRESHOLD) return "low";
    if (width < ADAPTIVE_HIGH_THRESHOLD) return "medium";
    return "high";
  };
  switch (current) {
    case "low":
      if (width >= ADAPTIVE_LOW_THRESHOLD * ADAPTIVE_HYSTERESIS) {
        return width >= ADAPTIVE_HIGH_THRESHOLD * ADAPTIVE_HYSTERESIS ? "high" : "medium";
      }
      return "low";
    case "medium":
      if (width >= ADAPTIVE_HIGH_THRESHOLD * ADAPTIVE_HYSTERESIS) return "high";
      return width < ADAPTIVE_LOW_THRESHOLD ? "low" : "medium";
    case "high":
      if (width < ADAPTIVE_LOW_THRESHOLD) return "low";
      return width < ADAPTIVE_HIGH_THRESHOLD ? "medium" : "high";
    default:
      return plain();
  }
}
var AdaptiveStreamController = class _AdaptiveStreamController {
  constructor(options) {
    this.options = options;
    this.elements = /* @__PURE__ */ new Map();
    this.disposed = false;
    // --- Visibility ------------------------------------------------------
    //
    // A track is visible while at least one element it is attached to is in
    // the document, has a size, intersects the viewport, and the page itself
    // is not hidden — or is the picture-in-picture element, which stays on
    // screen when the tab does not. A track that has never been attached is
    // visible: the SDK cannot see how it is being used (a canvas, a
    // recorder, a React Native view), and pausing what it cannot see would
    // break all of those.
    /** Last intersection report per element. Absent means "not reported", read as intersecting. */
    this.intersecting = /* @__PURE__ */ new Map();
    this.everObserved = false;
    this.reportedVisible = true;
  }
  /** Whether this environment can observe element size at all. */
  static get supported() {
    return typeof ResizeObserver !== "undefined";
  }
  observe(element) {
    if (this.disposed || !_AdaptiveStreamController.supported) return;
    if (!this.observer) {
      this.observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          this.elements.set(entry.target, this.widthOf(entry));
        }
        this.schedule();
        this.updateVisibility();
      });
    }
    this.elements.set(element, this.currentWidthOf(element));
    this.observer.observe(element);
    this.everObserved = true;
    this.observeVisibility(element);
    this.schedule();
    this.updateVisibility();
  }
  unobserve(element) {
    this.elements.delete(element);
    this.intersecting.delete(element);
    this.observer?.unobserve(element);
    this.intersectionObserver?.unobserve(element);
    if (this.elements.size > 0) {
      this.schedule();
    }
    this.updateVisibility();
  }
  /**
   * A visibility report from a renderer the SDK cannot observe (see
   * `RemoteTrack.setVisible`). `false` hides the track whatever its
   * elements say; `true` hands the decision back to them.
   */
  setVisible(visible) {
    if (this.disposed) return;
    this.manualVisible = visible;
    this.updateVisibility();
  }
  /** Whether the track currently counts as on screen (after debouncing). */
  get visible() {
    return this.reportedVisible;
  }
  dispose() {
    this.disposed = true;
    this.clearTimer();
    this.clearVisibilityTimer();
    this.observer?.disconnect();
    this.observer = void 0;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = void 0;
    if (this.visibilityListener && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityListener);
    }
    this.visibilityListener = void 0;
    this.elements.clear();
    this.intersecting.clear();
  }
  /**
   * Re-checks visibility now, skipping the pause delay. For tests, and for
   * a caller that knows the layout settled.
   */
  flushVisibility() {
    this.clearVisibilityTimer();
    const visible = this.computeVisible();
    if (visible !== this.reportedVisible) {
      this.reportedVisible = visible;
      this.options.visibility?.(visible);
    }
  }
  observeVisibility(element) {
    if (typeof IntersectionObserver !== "undefined") {
      if (!this.intersectionObserver) {
        this.intersectionObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (this.elements.has(entry.target)) {
              this.intersecting.set(entry.target, entry.isIntersecting);
            }
          }
          this.updateVisibility();
        });
      }
      this.intersectionObserver.observe(element);
    }
    if (!this.visibilityListener && typeof document !== "undefined" && document.addEventListener) {
      this.visibilityListener = () => this.updateVisibility();
      document.addEventListener("visibilitychange", this.visibilityListener);
    }
  }
  computeVisible() {
    if (this.manualVisible === false) return false;
    if (!this.everObserved) return true;
    if (this.elements.size === 0) return false;
    const pip = typeof document !== "undefined" ? document.pictureInPictureElement : null;
    const pageHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    for (const [element, width] of this.elements) {
      if (pip && pip === element) return true;
      if (pageHidden) continue;
      if (element.isConnected === false) continue;
      if (!(width > 0) && !(this.currentWidthOf(element) > 0)) continue;
      if (this.intersecting.get(element) === false) continue;
      return true;
    }
    return false;
  }
  updateVisibility() {
    if (this.disposed) return;
    const visible = this.computeVisible();
    if (visible) {
      this.clearVisibilityTimer();
      if (!this.reportedVisible) {
        this.reportedVisible = true;
        this.options.visibility?.(true);
      }
      return;
    }
    if (!this.reportedVisible || this.visibilityTimer !== void 0) return;
    const setTimer = this.options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.visibilityTimer = setTimer(() => {
      this.visibilityTimer = void 0;
      if (this.disposed || this.computeVisible() || !this.reportedVisible) return;
      this.reportedVisible = false;
      this.options.visibility?.(false);
    }, ADAPTIVE_PAUSE_DELAY_MS);
  }
  clearVisibilityTimer() {
    if (this.visibilityTimer === void 0) return;
    const clear = this.options.clearTimer ?? ((handle) => clearTimeout(handle));
    clear(this.visibilityTimer);
    this.visibilityTimer = void 0;
  }
  /**
   * Re-evaluates now, skipping the debounce.
   *
   * For the caller that already knows the size settled — a test, or a
   * resubscribe after reconnect where the SFU has forgotten the preference
   * and waiting 250ms would leave the tile on the wrong layer meanwhile.
   */
  flush() {
    this.clearTimer();
    this.evaluate();
  }
  schedule() {
    if (this.disposed) return;
    this.clearTimer();
    const setTimer = this.options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.timer = setTimer(() => this.evaluate(), ADAPTIVE_DEBOUNCE_MS);
  }
  evaluate() {
    if (this.disposed || this.elements.size === 0) return;
    const widest = Math.max(...this.elements.values());
    if (!Number.isFinite(widest) || widest <= 0) return;
    const next = layerForWidth(widest, this.current);
    if (next === this.current) return;
    this.current = next;
    this.options.request(next);
  }
  clearTimer() {
    if (this.timer === void 0) return;
    const clear = this.options.clearTimer ?? ((handle) => clearTimeout(handle));
    clear(this.timer);
    this.timer = void 0;
  }
  widthOf(entry) {
    const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
    if (box && typeof box.inlineSize === "number" && box.inlineSize > 0) {
      return box.inlineSize;
    }
    if (entry.contentRect && entry.contentRect.width > 0) {
      return entry.contentRect.width;
    }
    return this.currentWidthOf(entry.target);
  }
  currentWidthOf(element) {
    const width = element.clientWidth;
    return typeof width === "number" && width > 0 ? width : 0;
  }
};

// src/internal/sfu/simulcast.ts
var SIMULCAST_LAYERS = [
  { rid: "low", scaleResolutionDownBy: 4, maxBitrate: 15e4, maxFramerate: 15 },
  { rid: "medium", scaleResolutionDownBy: 2, maxBitrate: 5e5, maxFramerate: 30 },
  { rid: "high", scaleResolutionDownBy: 1, maxBitrate: 15e5, maxFramerate: 30 }
];
function simulcastSendEncodings() {
  return SIMULCAST_LAYERS.map((layer) => ({
    rid: layer.rid,
    scaleResolutionDownBy: layer.scaleResolutionDownBy,
    maxBitrate: layer.maxBitrate,
    maxFramerate: layer.maxFramerate
  }));
}
function kindUsesSimulcast(kind) {
  return kind === "camera";
}
function confirmSimulcast(sender) {
  let rids = [];
  try {
    const parameters = sender.getParameters();
    const encodings = parameters.encodings ?? [];
    const mode = encodings[0]?.scalabilityMode;
    if (encodings.length === 1 && typeof mode === "string" && /^L[23]T/.test(mode)) {
      return { status: "svc", rids: [] };
    }
    rids = encodings.map((encoding) => encoding.rid).filter((rid) => typeof rid === "string" && rid.length > 0);
  } catch {
    return { status: "unsupported", rids: [] };
  }
  const wanted = SIMULCAST_LAYERS.map((layer) => layer.rid);
  const present = new Set(rids);
  const complete = wanted.every((rid) => present.has(rid));
  return { status: complete ? "enabled" : "unsupported", rids };
}

// src/internal/sfu/codecs.ts
var SVC_SCALABILITY_MODE = "L3T3_KEY";
var SVC_MAX_BITRATE = 17e5;
function capabilities(kind) {
  if (typeof RTCRtpSender === "undefined" || typeof RTCRtpSender.getCapabilities !== "function") return [];
  try {
    return RTCRtpSender.getCapabilities(kind)?.codecs ?? [];
  } catch {
    return [];
  }
}
function preferCodec(codecs, mimeType) {
  const wanted = mimeType.toLowerCase();
  const first = codecs.filter((codec) => codec.mimeType.toLowerCase() === wanted);
  if (first.length === 0) return void 0;
  return [...first, ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== wanted)];
}
function redFirstAudioCodecs() {
  return preferCodec(capabilities("audio"), "audio/red");
}
function videoCodecsPreferring(codec) {
  return preferCodec(capabilities("video"), `video/${codec}`);
}
function svcSupported(codec) {
  if (codec !== "vp9" && codec !== "av1") return false;
  const entries = capabilities("video").filter((c) => c.mimeType.toLowerCase() === `video/${codec}`);
  if (entries.length === 0) return false;
  return entries.some((entry) => {
    const modes = entry.scalabilityModes;
    return modes === void 0 || modes.includes(SVC_SCALABILITY_MODE);
  });
}
function svcSendEncodings() {
  return [{ scalabilityMode: SVC_SCALABILITY_MODE, maxBitrate: SVC_MAX_BITRATE }];
}

// src/e2ee/support.ts
function hasScriptTransform() {
  return typeof RTCRtpScriptTransform !== "undefined";
}
function hasEncodedStreams() {
  return typeof RTCRtpSender !== "undefined" && typeof RTCRtpSender.prototype.createEncodedStreams === "function";
}
function isE2EESupported() {
  return hasScriptTransform() || hasEncodedStreams();
}

// src/internal/signaling/protocol.ts
var ClientMessageType = {
  ROOM_JOIN: "room.join",
  ROOM_LEAVE: "room.leave",
  SDP_ANSWER: "sdp.answer",
  SDP_OFFER: "sdp.offer",
  ICE_CANDIDATE: "ice.candidate",
  TRACK_MUTE: "track.mute",
  /**
   * Declares what a track being published is *of*.
   *
   * Needed because WebRTC has no such concept, and a page can't choose the
   * `MediaStream` or `MediaStreamTrack` id the SDP will carry; both are
   * read-only. Without this the SFU can only guess the source from codec
   * kind, and that can't tell a screen share from a camera.
   */
  TRACK_PUBLISH: "track.publish",
  SUBSCRIPTION_UPDATE: "subscription.update",
  /** A fresh RTC token for the live session (docs/architecture/phase1-contracts.md §1.1). */
  TOKEN_REFRESH: "token.refresh",
  /** Phase 7 §2: this participant's own metadata/attributes (needs `perms.updateOwnMetadata`). */
  PARTICIPANT_UPDATE: "participant.update",
  PING: "ping"
};
var ServerMessageType = {
  ROOM_JOINED: "room.joined",
  ROOM_LEFT: "room.left",
  PARTICIPANT_JOINED: "participant.joined",
  PARTICIPANT_LEFT: "participant.left",
  TRACK_PUBLISHED: "track.published",
  TRACK_UNPUBLISHED: "track.unpublished",
  TRACK_MUTED: "track.muted",
  TRACK_UNMUTED: "track.unmuted",
  SDP_OFFER: "sdp.offer",
  SDP_ANSWER: "sdp.answer",
  ICE_CANDIDATE: "ice.candidate",
  CONNECTION_STATE: "connection.state",
  ERROR: "error",
  // Phase 1 resilience additions (docs/architecture/phase1-contracts.md §1).
  // Additive: a server that predates them simply never sends them.
  TOKEN_EXPIRING: "token.expiring",
  TOKEN_REFRESHED: "token.refreshed",
  ROOM_RESUME_TOKEN: "room.resume_token",
  PARTICIPANT_PERMISSIONS_UPDATED: "participant.permissions_updated",
  // Phase 2 media-quality additions (docs/architecture/phase2-media-contracts.md).
  // Additive like the Phase 1 set: an older server never sends them.
  /** §2: the room's ordered active-speaker set changed. */
  SPEAKERS_CHANGED: "speakers.changed",
  /** §3: one or more participants' connection-quality scores changed. */
  QUALITY_CHANGED: "quality.changed",
  /** §4: one of this subscriber's tracks changed forwarding state or layer. */
  SUBSCRIPTION_STATE: "subscription.state",
  /** §5: which simulcast layers of a published track anyone is receiving. */
  PUBLISHER_LAYERS: "publisher.layers",
  // Phase 7 additions (docs/architecture/phase7-contracts.md). Additive.
  /** §2: someone's metadata or attributes changed. */
  PARTICIPANT_UPDATED: "participant.updated",
  /** §1.4: the SFU dropped some of this participant's data messages over the rate limit. */
  DATA_THROTTLED: "data.throttled",
  // Phase 6 additions (docs/architecture/phase6-contracts.md §4). Additive.
  /** §4.1: a live caption, interim (replaced by the next with its segmentId) or final. */
  TRANSCRIPTION_SEGMENT: "transcription.segment",
  /** §4.3: the room's transcription changed status. */
  TRANSCRIPTION_STATE: "transcription.state",
  /** §4.2: an AI agent in the room is listening, thinking, speaking, or has ended. */
  AGENT_STATE: "agent.state"
};
var CloseCode = {
  /** The API is shutting down gracefully. Reconnect now, with resume (§1.3). */
  SERVICE_RESTART: 1012,
  /** Authentication failed, or the token expired with enforcement on (§1.1). */
  AUTH_FAILED: 4001,
  /** Removed by the server, or the room was closed. Never auto-reconnect (§1.5). */
  REMOVED: 4003
};
var FATAL_ERROR_CODES = /* @__PURE__ */ new Set([
  "INVALID_TOKEN",
  "TOKEN_EXPIRED",
  // Someone killed this credential on purpose. Retrying re-presents the
  // same dead token; the application's backend has to mint a new one.
  "TOKEN_REVOKED",
  "UNAUTHORIZED",
  "ROOM_NOT_FOUND",
  "PERMISSION_DENIED",
  // Reconnecting cannot help: the page's origin is not on the project's
  // allow-list, and that is changed in the dashboard, not by retrying.
  "ORIGIN_NOT_ALLOWED",
  // Not a credential problem, but just as terminal, and it belongs here
  // for the reconnect behaviour rather than the reason. The account is out
  // of included minutes: unlike RATE_LIMITED there is no window to wait
  // out, so backing off and retrying would spin against a wall until the
  // attempt budget ran out. A fresh token would not help either — the
  // limit is on the account, not the token.
  "USAGE_LIMIT_EXCEEDED"
]);

// src/internal/signaling/signaling-client.ts
var OPEN_TIMEOUT_MS = 1e4;
var JOIN_TIMEOUT_MS = 15e3;
var RECONNECT_BASE_MS = 300;
var RECONNECT_MAX_MS = 1e4;
var RECONNECT_MAX_ATTEMPTS = 12;
var SERVICE_RESTART_JITTER_MS = 2e3;
var RESUME_TOKEN_MAX_AGE_MS = 11e4;
var TOKEN_REFRESH_SKEW_MS = 3e4;
var SignalingClient = class extends TypedEventEmitter {
  constructor(options) {
    super();
    this.reconnectAttempts = 0;
    this.closedByCaller = false;
    this.joined = false;
    /**
     * The server said this session's token expired (§1.1 enforcement) and a
     * `refreshToken` is configured, so the 4001 close that follows means
     * "refresh and reconnect" rather than "stop".
     */
    this.expiredAwaitingRefresh = false;
    this.liveRefreshInFlight = false;
    this.options = options;
    this.token = options.token;
    this.logger = options.logger;
  }
  get isJoined() {
    return this.joined;
  }
  /** True while a reconnect is scheduled or in progress. */
  get isReconnecting() {
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
  async connect() {
    this.closedByCaller = false;
    this.endedReason = void 0;
    try {
      return await this.openAndJoin(false);
    } catch (error) {
      this.closedByCaller = true;
      throw error;
    }
  }
  async openAndJoin(isReconnect) {
    const socket = await this.openSocket();
    this.socket = socket;
    return this.join(socket, isReconnect);
  }
  openSocket() {
    const url = this.buildUrl();
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(new RTCError("SIGNALING_ERROR", "Could not open a signaling connection", error));
        return;
      }
      const timeout = setTimeout(() => {
        socket.close();
        reject(new RTCError("TIMEOUT", `Signaling connection to ${this.options.endpoint} timed out`));
      }, OPEN_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timeout);
        this.logger.debug("signaling socket open");
        resolve(socket);
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new RTCError("NETWORK_ERROR", `Could not reach the signaling endpoint at ${this.options.endpoint}`));
      };
    });
  }
  join(socket, isReconnect) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let joinedOnThisSocket = false;
      const fail = (error, failure2) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error.joinFailure = failure2;
        reject(error);
        try {
          socket.close();
        } catch {
        }
      };
      const timeout = setTimeout(() => {
        fail(new RTCError("TIMEOUT", "The server did not confirm the room join"), {});
      }, JOIN_TIMEOUT_MS);
      socket.onmessage = (event) => {
        const message = this.parse(event.data);
        if (!message) {
          return;
        }
        if (!settled) {
          if (message.type === ServerMessageType.ROOM_JOINED) {
            settled = true;
            joinedOnThisSocket = true;
            clearTimeout(timeout);
            const askedToResume = isReconnect && sentResume;
            const payload = {
              roomId: message.roomId,
              participants: message.participants,
              rtcServer: message.rtcServer,
              region: message.region,
              e2ee: message.e2ee === true,
              capabilities: Array.isArray(message.capabilities) ? message.capabilities : [],
              // Only meaningful if we asked. A server that ignores a resume
              // request it does not understand must read as "fresh".
              resumed: askedToResume && message.resumed === true
            };
            this.storeResumeToken(message.resumeToken);
            this.joined = true;
            this.reconnectAttempts = 0;
            this.logger.info(
              payload.resumed ? "resumed room session" : "joined room",
              message.roomId,
              message.rtcServer ? `via ${message.rtcServer}` : ""
            );
            resolve(payload);
            this.emit("joined", payload);
            return;
          }
          if (message.type === ServerMessageType.ERROR) {
            fail(this.toError(message.code, message.message), { serverCode: message.code });
            return;
          }
        }
        this.handleMessage(message);
      };
      socket.onclose = (event) => {
        if (!joinedOnThisSocket) {
          fail(
            new RTCError(
              "SIGNALING_ERROR",
              `The signaling connection closed before the room was joined (code ${event.code})`
            ),
            { closeCode: event.code }
          );
          return;
        }
        if (socket !== this.socket) {
          return;
        }
        this.joined = false;
        this.handleClose(event);
      };
      socket.onerror = () => {
      };
      const resume = isReconnect ? this.usableResumeToken() : void 0;
      const sentResume = resume !== void 0;
      this.send({
        type: ClientMessageType.ROOM_JOIN,
        roomId: this.options.roomId,
        region: this.options.region,
        ...resume ? { resume: { token: resume } } : {},
        // Only the non-default value goes on the wire, so a join from an
        // application that never set it is byte-for-byte what it was.
        ...this.options.autoSubscribe === false ? { autoSubscribe: false } : {}
      });
    });
  }
  handleMessage(message) {
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
          this.token = this.pendingRefreshToken;
          this.pendingRefreshToken = void 0;
        }
        this.logger.debug("rtc token refreshed; session now expires at", message.expiresAt);
        return;
      case ServerMessageType.ROOM_LEFT:
        this.handleRoomLeft(message.reason);
        break;
    }
    this.emit("message", message);
  }
  /**
   * Handles an `error` frame on an established session. Returns true when
   * it was fully handled here and must not reach the adapter.
   */
  handleErrorFrame(code, text) {
    if (code === "TOKEN_INVALID") {
      this.pendingRefreshToken = void 0;
      this.logger.warn("the server refused the refreshed rtc token", text);
      this.emit("warning", { code: "TOKEN_REFRESH_FAILED", message: text });
      return true;
    }
    if (code === "ROOM_CLOSED") {
      this.endedReason = "ROOM_CLOSED";
      return true;
    }
    if (code === "TOKEN_EXPIRED" && this.options.refreshToken && this.options.autoReconnect) {
      this.expiredAwaitingRefresh = true;
      this.logger.warn("rtc token expired on the server; will refresh and reconnect");
      return true;
    }
    this.logger.warn("signaling error", code, text);
    if (FATAL_ERROR_CODES.has(code)) {
      this.closedByCaller = true;
      this.clearResume();
      this.emit("failed", this.toError(code, text), code === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "CONNECTION_FAILED");
      this.socket?.close();
      return true;
    }
    return false;
  }
  handleRoomLeft(reason) {
    if (!reason) {
      return;
    }
    if (reason === "TOKEN_EXPIRED" && this.options.refreshToken && this.options.autoReconnect) {
      this.expiredAwaitingRefresh = true;
      return;
    }
    this.endedReason = reason === "REMOVED" || reason === "ROOM_CLOSED" || reason === "TOKEN_EXPIRED" ? reason : "REMOVED";
    this.clearResume();
    this.socket?.close(1e3, "session ended by server");
  }
  handleClose(event) {
    if (this.closedByCaller) {
      this.emit("closed");
      return;
    }
    if (this.endedReason || event.code === CloseCode.REMOVED) {
      const reason = this.endedReason ?? "REMOVED";
      this.endedReason = void 0;
      this.closedByCaller = true;
      this.clearResume();
      this.logger.info("the server ended this session", reason);
      this.emit("ended", reason);
      return;
    }
    const authFailed = event.code === CloseCode.AUTH_FAILED || this.expiredAwaitingRefresh;
    if (authFailed) {
      this.clearResume();
    }
    if (!this.options.autoReconnect) {
      this.closedByCaller = true;
      this.emit(
        "failed",
        authFailed ? new RTCError("TOKEN_EXPIRED", "The signaling connection was closed because the RTC token expired") : new RTCError("NETWORK_ERROR", `The signaling connection closed (code ${event.code})`),
        authFailed ? "TOKEN_EXPIRED" : "CONNECTION_FAILED"
      );
      return;
    }
    if (authFailed) {
      this.expiredAwaitingRefresh = false;
      if (!this.options.refreshToken) {
        this.closedByCaller = true;
        this.emit(
          "failed",
          new RTCError(
            "TOKEN_EXPIRED",
            "The RTC token expired. Pass refreshToken to createRTCClient() to keep long sessions alive"
          ),
          "TOKEN_EXPIRED"
        );
        return;
      }
      void this.scheduleReconnect({ refreshFirst: true });
      return;
    }
    if (event.code === CloseCode.SERVICE_RESTART) {
      this.logger.info("signaling server restarting; reconnecting with resume");
      void this.scheduleReconnect({ serviceRestart: true });
      return;
    }
    void this.scheduleReconnect({});
  }
  async scheduleReconnect(options) {
    if (this.closedByCaller) {
      return;
    }
    if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      this.closedByCaller = true;
      this.emit(
        "failed",
        new RTCError("CONNECTION_FAILED", `Could not re-establish signaling after ${RECONNECT_MAX_ATTEMPTS} attempts`),
        "CONNECTION_FAILED"
      );
      return;
    }
    this.reconnectAttempts++;
    this.emit("reconnecting", { resuming: this.usableResumeToken() !== void 0 });
    if (options.refreshFirst || this.tokenExpiresSoon()) {
      const refreshed = await this.tryRefreshToken();
      if (this.closedByCaller) {
        return;
      }
      if (!refreshed && options.refreshFirst) {
        this.logger.warn("reconnecting without a fresh token; the server may reject it again");
      }
    }
    const delay = options.serviceRestart ? Math.random() * SERVICE_RESTART_JITTER_MS : (
      // Full jitter. Every client picks somewhere in [0, backoff), so a
      // fleet that all dropped together doesn't all come back together.
      Math.random() * Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1), RECONNECT_MAX_MS)
    );
    this.logger.info(`signaling reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay)}ms`);
    const attempt = () => {
      this.reconnectTimer = void 0;
      this.pendingAttempt = void 0;
      if (this.closedByCaller) {
        return;
      }
      void this.openAndJoin(true).then(
        () => {
          if (this.closedByCaller) {
            this.socket?.close(1e3, "client left");
          }
        },
        (error) => this.handleReconnectFailure(error)
      );
    };
    this.pendingAttempt = attempt;
    this.reconnectTimer = setTimeout(attempt, delay);
  }
  /** Decides what a failed reconnect attempt means: retry, refresh, or stop. */
  handleReconnectFailure(error) {
    if (this.closedByCaller) {
      return;
    }
    this.logger.warn("signaling reconnect failed", error.message);
    const failure2 = error.joinFailure ?? {};
    if (failure2.serverCode === "TOKEN_EXPIRED" && this.options.refreshToken) {
      void this.scheduleReconnect({ refreshFirst: true });
      return;
    }
    if (failure2.serverCode && FATAL_ERROR_CODES.has(failure2.serverCode)) {
      this.closedByCaller = true;
      this.emit("failed", error, failure2.serverCode === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "CONNECTION_FAILED");
      return;
    }
    if (failure2.closeCode === CloseCode.REMOVED || failure2.serverCode === "ROOM_CLOSED") {
      this.closedByCaller = true;
      this.emit("ended", failure2.serverCode === "ROOM_CLOSED" ? "ROOM_CLOSED" : "REMOVED");
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
  reconnectNow() {
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
  rejoin() {
    if (this.closedByCaller) {
      return;
    }
    this.clearResume();
    if (this.joined && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.close(1e3, "client rejoin");
    }
  }
  /**
   * Fetches a fresh token in answer to `token.expiring` and hands it to the
   * live session (§1.1). Without `refreshToken` the application is told
   * instead, since nothing else will.
   */
  async refreshLiveToken(expiresAt) {
    if (!this.options.refreshToken) {
      this.logger.warn("rtc token expiring at", expiresAt, "and no refreshToken is configured");
      this.emit("warning", {
        code: "TOKEN_EXPIRING",
        message: `The RTC token expires at ${expiresAt} and no refreshToken is configured`,
        expiresAt
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
      this.logger.warn("rtc token refresh failed", error.message);
      this.emit("warning", {
        code: "TOKEN_REFRESH_FAILED",
        message: `refreshToken() failed: ${error.message}`,
        expiresAt,
        cause: error
      });
    } finally {
      this.liveRefreshInFlight = false;
    }
  }
  /** Swaps in a fresh token for the next connection attempt. True if it got one. */
  async tryRefreshToken() {
    if (!this.options.refreshToken) {
      return false;
    }
    try {
      this.token = await this.options.refreshToken();
      this.pendingRefreshToken = void 0;
      this.logger.debug("rtc token refreshed");
      return true;
    } catch (error) {
      this.logger.warn("rtc token refresh failed", error.message);
      this.emit("warning", {
        code: "TOKEN_REFRESH_FAILED",
        message: `refreshToken() failed: ${error.message}`,
        cause: error
      });
      return false;
    }
  }
  /** Whether the current token is expired or about to be. Unknown expiry reads as "no". */
  tokenExpiresSoon() {
    try {
      const { exp } = decodeTokenPayload(this.token);
      return exp !== void 0 && exp * 1e3 - Date.now() < TOKEN_REFRESH_SKEW_MS;
    } catch {
      return false;
    }
  }
  storeResumeToken(token) {
    if (typeof token === "string" && token.length > 0) {
      this.resume = { token, receivedAt: Date.now() };
    }
  }
  usableResumeToken() {
    if (!this.resume) {
      return void 0;
    }
    if (Date.now() - this.resume.receivedAt > RESUME_TOKEN_MAX_AGE_MS) {
      return void 0;
    }
    return this.resume.token;
  }
  clearResume() {
    this.resume = void 0;
  }
  /** Replaces the token used by future reconnects (spec §21). */
  setToken(token) {
    this.token = token;
  }
  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.logger.debug("dropping signaling message, socket not open", message.type);
      return;
    }
    this.socket.send(JSON.stringify(message));
  }
  /** Leaves the room and closes the socket. No reconnect afterwards. */
  close() {
    this.closedByCaller = true;
    this.clearResume();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = void 0;
      this.pendingAttempt = void 0;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: ClientMessageType.ROOM_LEAVE });
      this.socket.close(1e3, "client left");
    }
    this.joined = false;
  }
  buildUrl() {
    const base = this.options.endpoint.replace(/\/$/, "");
    return `${base}?token=${encodeURIComponent(this.token)}`;
  }
  parse(data) {
    if (typeof data !== "string") {
      this.logger.warn("ignoring non-text signaling frame");
      return void 0;
    }
    try {
      return JSON.parse(data);
    } catch {
      this.logger.warn("ignoring unparseable signaling frame");
      return void 0;
    }
  }
  toError(code, message) {
    switch (code) {
      case "INVALID_TOKEN":
        return new RTCError("INVALID_TOKEN", message);
      case "TOKEN_EXPIRED":
        return new RTCError("TOKEN_EXPIRED", message);
      case "TOKEN_REVOKED":
        return new RTCError("TOKEN_REVOKED", message);
      // Surfaced as its own code rather than falling through to
      // SIGNALING_ERROR, so an application can tell "you are out of
      // minutes" from "signaling broke" and show a billing prompt instead
      // of a retry button.
      case "USAGE_LIMIT_EXCEEDED":
        return new RTCError("USAGE_LIMIT_EXCEEDED", message);
      case "ROOM_NOT_FOUND":
        return new RTCError("ROOM_NOT_FOUND", message);
      // ORIGIN_NOT_ALLOWED belongs here rather than in the default: the
      // token was valid, it was the page holding it that was not on the
      // project's allow-list. Letting it fall through to SIGNALING_ERROR
      // would bury the server's message naming the dashboard setting to
      // change.
      case "UNAUTHORIZED":
      case "PERMISSION_DENIED":
      case "ORIGIN_NOT_ALLOWED":
        return new RTCError("PERMISSION_DENIED", message);
      case "ROOM_FULL":
      case "NO_RTC_CAPACITY":
      case "RTC_SERVER_UNREACHABLE":
        return new RTCError("CONNECTION_FAILED", message);
      case "RATE_LIMITED":
        return new RTCError("NETWORK_ERROR", message);
      default:
        return new RTCError("SIGNALING_ERROR", message);
    }
  }
};

// src/internal/sfu/swalvo-adapter.ts
var DATA_CHANNEL_LABEL = "raven-data";
var LOSSY_DATA_CHANNEL_LABEL = "raven-data-lossy";
var MAX_LOSSY_QUEUE = 64;
var DATA_V2_PROTOCOL = "raven.v2";
var DATA_V2_CAPABILITY = "data.v2";
var MAX_DATA_PAYLOAD_BYTES = MAX_RELIABLE_PAYLOAD_BYTES;
var MEDIA_REJOIN_MAX_ATTEMPTS = 5;
var MEDIA_REJOIN_BASE_MS = 1e3;
var MEDIA_REJOIN_MAX_MS = 1e4;
function trackKindFromSource(source, kind) {
  switch (source) {
    case "camera":
      return "camera";
    case "microphone":
      return "microphone";
    case "screenShare":
      return "screenShare";
    case "screenShareAudio":
      return "screenShareAudio";
    default:
      return kind === "audio" ? "microphone" : "camera";
  }
}
var SERVER_QUALITIES = /* @__PURE__ */ new Set(["excellent", "good", "poor", "lost"]);
var SUBSCRIPTION_STATES = /* @__PURE__ */ new Set(["active", "paused_bandwidth", "paused_client"]);
var FORWARDED_LAYERS = /* @__PURE__ */ new Set(["low", "medium", "high", "off"]);
var RID_ALIASES = { q: "low", h: "medium", f: "high", low: "q", medium: "h", high: "f" };
var SwalvoAdapter = class extends TypedEventEmitter {
  constructor(logger, autoReconnect, options) {
    super();
    this.remoteParticipants = /* @__PURE__ */ new Map();
    /**
     * Phase 6 §4.2: an `agent.state` for an agent whose `participant.joined`
     * has not arrived yet (the worker reports `listening` as it connects).
     * Applied the moment the participant appears.
     */
    this.pendingAgentStates = /* @__PURE__ */ new Map();
    /** Desired state like `dataChannelWanted`: re-opened on a new connection. */
    this.lossyChannelWanted = false;
    this.lossyQueue = [];
    /** `room.joined.capabilities` includes `data.v2`. Refreshed on every join. */
    this.supportsDataV2 = false;
    this.lossyFallbackWarned = false;
    this.iceServers = [];
    this._connectionState = "disconnected";
    this.intentionalDisconnect = false;
    /**
     * The signaling socket dropped and the reconnect will offer a resume
     * token, so the PeerConnection was kept: if the server re-binds the old
     * SFU session it is still carrying our media. Settled by the next
     * `joined`, which either confirms it (`resumed: true`) or says the
     * session is new and the connection must be rebuilt.
     */
    this.awaitingResume = false;
    /** Media-only rejoins since the media connection was last `connected`. */
    this.mediaRejoinAttempts = 0;
    /** The next offer we make should restart ICE (a network change). */
    this.iceRestartRequested = false;
    /**
     * What this participant *wants* published, by kind.
     *
     * Desired state, deliberately not PeerConnection state. A reconnect
     * throws the PeerConnection away and with it every `RTCRtpSender`, but
     * the camera is still on and the developer never asked for it to stop —
     * so `sender` is the only field here that a replacement connection
     * invalidates, and `restoreLocalPublications()` refills it. Before this
     * split, a reconnect left the map holding senders belonging to a closed
     * connection: the tracks looked published, the new connection had no
     * transceivers for them, and the room went quiet.
     */
    this.published = /* @__PURE__ */ new Map();
    /** Subscribed tracks by `publisherId/trackId`. */
    this.subscribed = /* @__PURE__ */ new Map();
    /**
     * Layers an application pinned explicitly, by `publisherId/trackId`.
     * Adaptive streaming never overrides one. See {@link requestLayer}.
     */
    this.pinnedLayers = /* @__PURE__ */ new Map();
    /**
     * The layer last *sent* for a subscription, keyed the same way. Purely to
     * avoid re-sending a preference the SFU already has.
     */
    this.sentLayers = /* @__PURE__ */ new Map();
    /** Per-track size observers, by `publisherId/trackId`. */
    this.adaptiveControllers = /* @__PURE__ */ new Map();
    /**
     * Transceivers this SDK created for a simulcast kind.
     *
     * Deliberately not on the publication: a publication is deleted by
     * `unpublish`, and the transceiver has to outlive that. A ladder can only
     * be declared when a transceiver is created, so a camera toggled off and
     * on again cannot go back through `addTransceiver` without adding an
     * m-section that never goes away — a call where somebody fiddles with
     * their camera would carry an SDP to match.
     *
     * Cleared with the peer connection: a transceiver belongs to the
     * connection that created it, and a reconnect builds a new one.
     */
    this.simulcastTransceivers = /* @__PURE__ */ new Map();
    /**
     * What the server says each participant publishes, ahead of the media
     * actually turning up. `ontrack` and `track.published` race and either
     * can win, so both paths check in here and whichever lands second
     * finishes the subscription.
     */
    this.announcedTracks = /* @__PURE__ */ new Map();
    /** Tracks whose media arrived before the announcement. */
    this.pendingMedia = /* @__PURE__ */ new Map();
    /**
     * Serializes everything that touches the signaling state machine —
     * remote offers, remote answers, our own offers, remote candidates.
     * See `enqueue()`.
     */
    this.negotiationChain = Promise.resolve();
    /** A local change is waiting for an offer to carry it. */
    this.negotiationNeeded = false;
    /** An offer task is already on the chain, so more requests coalesce into it. */
    this.negotiationScheduled = false;
    /** Callers of `dataChannelOpened()`, settled when the channel opens. */
    this.dataChannelWaiters = [];
    /** In-flight enable/disable per track kind. See `withKindLock()`. */
    this.kindOperations = /* @__PURE__ */ new Map();
    /**
     * Whether this page has asked for a data channel.
     *
     * Desired state, like `published`: the channel itself belongs to a
     * PeerConnection and does not survive a reconnect, but the intent does.
     */
    this.dataChannelWanted = false;
    /** Payloads accepted while the channel was still opening. */
    this.dataQueue = [];
    /**
     * Track ids we have already offered once to get onto the wire.
     *
     * `publishedTracksMissingFromSdp()` asks for one corrective offer per
     * published track and then stops asking, whatever the outcome. A
     * standing condition instead of a one-shot is a treadmill: if the
     * browser will not put our id in the description — a reused transceiver
     * whose msid it considers settled — then re-checking after every round
     * trip re-offers forever. Bounding it costs a mislabelled track source
     * in that corner; not bounding it costs the connection.
     */
    this.msidRefreshAttempted = /* @__PURE__ */ new Set();
    /** The room requires E2EE: the token's `e2ee` claim or `room.joined.e2ee` (phase5-contracts §3.1). */
    this.roomE2EE = false;
    /**
     * The id the shared passphrase is salted with: the token's `rid`, which is
     * also the `roomId` every SDK sends in `room.join` — so web, Flutter and
     * the native SDKs derive the same key for the same room.
     */
    this.e2eeRoomId = "";
    /** Last reported E2EE state per participant, so `e2eeStateChanged` fires on changes only. */
    this.e2eeStates = /* @__PURE__ */ new Map();
    /** Current active speakers, loudest first (§2). */
    this._activeSpeakers = [];
    /**
     * Subscription states that arrived before their track did (§4). The SFU
     * can report a subscription as paused before `ontrack` has fired here;
     * dropping that report would leave the track claiming `active` until the
     * next change, which may never come.
     */
    this.pendingSubscriptionStates = /* @__PURE__ */ new Map();
    /**
     * Subscriptions the application paused with `track.setEnabled(false)`,
     * by `publisherId/trackId`. Application intent, like `pinnedLayers`, so
     * it survives a reconnect that rebuilds the track objects.
     */
    this.disabledTracks = /* @__PURE__ */ new Set();
    /**
     * What `publisher.layers` (§5) last asked of each published track's
     * encodings, by RID, keyed by publication kind. Re-applied after every
     * negotiation round, because some engines reset encoding parameters
     * when a description is applied; cleared whenever a publication gets a
     * new sender, since the SFU session behind it re-announces its demand.
     */
    this.layerActivity = /* @__PURE__ */ new Map();
    /** Serializes `setParameters` per sender: a read-modify-write that must not interleave. */
    this.senderParameterChains = /* @__PURE__ */ new WeakMap();
    /** Set once a browser refuses an SVC encoding, so later publishes go straight to simulcast. */
    this.svcRefused = false;
    this.logger = logger;
    this.autoReconnect = autoReconnect;
    this.adaptiveStream = options?.adaptiveStream ?? true;
    this.preferredVideoCodec = options?.preferredVideoCodec;
    this.refreshToken = options?.refreshToken;
    this.autoSubscribe = options?.autoSubscribe ?? true;
    this.audioRed = options?.audioRed ?? true;
    this.e2eeOptions = options?.e2ee;
    this.localParticipant = new LocalParticipant("");
    this.localParticipant._setUpdater({
      canUpdateMetadata: () => this._permissions?.updateOwnMetadata === true,
      sendUpdate: (update) => {
        if (!this.signaling) {
          throw new RTCError("CONNECTION_FAILED", "Not connected to a room");
        }
        this.signaling.send({ type: ClientMessageType.PARTICIPANT_UPDATE, ...update });
      }
    });
  }
  /** Whether the server announced data messages v2 (`room.joined.capabilities`). */
  get dataV2Supported() {
    return this.supportsDataV2;
  }
  get connectionState() {
    return this._connectionState;
  }
  get lastDisconnect() {
    return this._lastDisconnect;
  }
  /**
   * This participant's permissions: the token's grants at first, then
   * whatever the server last pushed (§1.4). Undefined when the token
   * carries no grants to read.
   */
  get permissions() {
    return this._permissions ? { ...this._permissions } : void 0;
  }
  /**
   * The SFU's read on this connection's health.
   *
   * `'lost'` once the connection has failed, either side's view. Otherwise
   * the score the SFU last sent for this participant
   * (docs/architecture/phase2-media-contracts.md §3), which has a vantage
   * point no client can get near: it sees loss and jitter on every leg of
   * the room, not just this one. Before the first score, and against a
   * server that does not score at all, it is `'unknown'` — dressing a
   * client-side guess up as a server verdict is precisely the fabricated
   * metric spec §19 rules out. `room.getConnectionStats()` gives real
   * per-track numbers either way.
   */
  getConnectionQuality() {
    if (this.sfuPeerState === "failed" || this._connectionState === "failed") {
      return "lost";
    }
    return this.localParticipant.connectionQuality;
  }
  /** Current active speakers, loudest first. Empty when nobody is speaking. */
  get activeSpeakers() {
    return [...this._activeSpeakers];
  }
  /**
   * The media connection's raw stats report, for the pre-call test.
   * Undefined with no connection. Not on `SFUAdapter`: nothing public
   * should depend on a raw WebRTC report.
   */
  async getStatsReport() {
    return this.pc ? this.pc.getStats() : void 0;
  }
  /** Diagnostics the LiveKit adapter never could give us (see `Room.getDiagnostics()`). */
  getIceConnectionState() {
    return this.pc?.iceConnectionState;
  }
  getSignalingState() {
    return this.pc?.signalingState;
  }
  /** The SFU's own view. It can disagree with the local one, and that disagreement is usually the interesting bit. */
  getRemoteConnectionState() {
    return { iceState: this.sfuIceState, peerState: this.sfuPeerState };
  }
  async getConnectionRoundTripTimeMs() {
    return this.pc ? connectionRoundTripTimeMs(this.pc) : void 0;
  }
  // --- Connection --------------------------------------------------------
  async connect(endpoint, token, iceServers) {
    this.iceServers = iceServers ?? [];
    this.intentionalDisconnect = false;
    this._lastDisconnect = void 0;
    this.mediaRejoinAttempts = 0;
    this.setConnectionState("connecting");
    const roomId = roomIdFromToken(token);
    this.localParticipant._setIdentity(participantIdFromToken(token));
    this._permissions = permissionsFromToken(token);
    const claims = decodeClaims(token);
    this.localParticipant._applyMetadata({
      metadata: typeof claims?.md === "string" ? claims.md : void 0,
      attributes: claims?.attrs && typeof claims.attrs === "object" ? claims.attrs : void 0
    });
    this.roomE2EE = claims?.e2ee === true;
    this.e2eeRoomId = roomId;
    this.setupE2EE();
    const signaling = new SignalingClient({
      endpoint,
      token,
      roomId,
      autoReconnect: this.autoReconnect,
      logger: this.logger,
      refreshToken: this.refreshToken,
      autoSubscribe: this.autoSubscribe
    });
    this.signaling = signaling;
    signaling.on("message", (message) => void this.handleSignalingMessage(message));
    signaling.on("reconnecting", ({ resuming }) => {
      this.setConnectionState("reconnecting");
      if (resuming && this.pc) {
        this.awaitingResume = true;
        return;
      }
      this.awaitingResume = false;
      this.discardMediaConnection();
    });
    signaling.on("joined", (payload) => void this.handleSignalingJoined(payload));
    signaling.on("failed", (error, reason) => {
      this.logger.error("signaling failed", error.message);
      this._lastDisconnect = { reason, error };
      this.cancelMediaRejoin();
      this.abortDataChannelWaiters("The connection failed before the data channel could open");
      this.setConnectionState("failed");
    });
    signaling.on("ended", (reason) => {
      this._lastDisconnect = { reason };
      this.endSession("The session was ended by the server before the data channel could open");
    });
    signaling.on("closed", () => {
      this.abortDataChannelWaiters("The connection closed before the data channel could open");
      this.setConnectionState(this.intentionalDisconnect ? "disconnected" : "failed");
    });
    signaling.on("warning", (warning) => this.emit("warning", warning));
    try {
      await signaling.connect();
    } catch (error) {
      this.setConnectionState("failed");
      throw error instanceof RTCError ? error : new RTCError("CONNECTION_FAILED", "Could not join the room", error);
    }
  }
  /**
   * Every `room.joined` the signaling client completes: the first one, and
   * one after each reconnect.
   *
   * After a reconnect that offered a resume token, this is where the kept
   * PeerConnection's fate is decided. `resumed: true` means the SFU still
   * has the session and the connection is live, so nothing local is
   * rebuilt; anything else means the server started a fresh session, and
   * the old connection is discarded and everything republished onto a new
   * one — the same path a reconnect without resume always takes.
   */
  async handleSignalingJoined(payload) {
    const wasAwaitingResume = this.awaitingResume;
    this.awaitingResume = false;
    if (payload.resumed) {
      this.logger.info("session resumed; keeping the media connection");
      await this.handleJoined(payload, { restorePublications: false });
      if (this.pc?.connectionState === "connected") {
        this.setConnectionState("connected");
      }
      return;
    }
    if (wasAwaitingResume) {
      this.logger.info("the server started a fresh session; rebuilding the media connection");
      this.discardMediaConnection();
    }
    await this.handleJoined(payload, { restorePublications: true });
  }
  /**
   * Applies whatever room state the server reported at join.
   *
   * Runs on first join and after every reconnect. On a reconnect the
   * server's participant list wins outright and the old one goes in the
   * bin: anyone who left during the outage must not linger, anyone who
   * joined during it must show up.
   */
  async handleJoined(payload, options = { restorePublications: true }) {
    this.logger.debug(
      "room state at join",
      `${payload.participants.length} participant(s)`,
      payload.rtcServer ? `on ${payload.rtcServer}` : ""
    );
    this.applyRoomE2EE(payload.roomId, payload.e2ee === true);
    if (Array.isArray(payload.capabilities)) {
      this.supportsDataV2 = payload.capabilities.includes(DATA_V2_CAPABILITY);
    }
    const present = new Set(payload.participants.map((participant) => participant.id));
    for (const [id, participant] of this.remoteParticipants) {
      if (!present.has(id)) {
        this.removeRemoteParticipant(participant);
      }
    }
    if (options.restorePublications) {
      this.restoreLocalPublications();
    }
    if (this.supportsDataV2) {
      if (!this.dataChannel) {
        this.openDataChannel();
      }
      if (!this.lossyChannel) {
        this.openLossyChannel();
      }
    }
    for (const entry of payload.participants) {
      let participant = this.remoteParticipants.get(entry.id);
      if (!participant) {
        participant = new RemoteParticipant(entry.id, entry.metadata ?? void 0, entry.attributes ?? void 0);
        this.remoteParticipants.set(entry.id, participant);
        this.emit("participantJoined", participant);
        this.applyPendingAgentState(participant);
      } else {
        this.applyParticipantMetadata(participant, entry);
      }
      for (const track of entry.tracks ?? []) {
        this.announceTrack(entry.id, track);
      }
    }
  }
  async handleSignalingMessage(message) {
    switch (message.type) {
      case ServerMessageType.ROOM_JOINED:
        await this.handleJoined({
          roomId: message.roomId,
          participants: message.participants,
          rtcServer: message.rtcServer,
          region: message.region,
          e2ee: message.e2ee,
          capabilities: message.capabilities
        });
        return;
      case ServerMessageType.SDP_OFFER:
        await this.enqueue(() => this.applyRemoteOffer(message.sdp));
        return;
      case ServerMessageType.SDP_ANSWER:
        await this.enqueue(() => this.applyRemoteAnswer(message.sdp));
        return;
      case ServerMessageType.ICE_CANDIDATE:
        await this.enqueue(() => this.applyRemoteCandidate(message));
        return;
      case ServerMessageType.PARTICIPANT_JOINED: {
        const existing = this.remoteParticipants.get(message.participant.id);
        if (existing) {
          return;
        }
        const participant = new RemoteParticipant(
          message.participant.id,
          message.participant.metadata ?? void 0,
          message.participant.attributes ?? void 0
        );
        this.remoteParticipants.set(participant.identity, participant);
        this.emit("participantJoined", participant);
        this.applyPendingAgentState(participant);
        return;
      }
      case ServerMessageType.PARTICIPANT_LEFT: {
        const participant = this.remoteParticipants.get(message.participant.id);
        if (!participant) {
          return;
        }
        this.removeRemoteParticipant(participant);
        return;
      }
      case ServerMessageType.PARTICIPANT_PERMISSIONS_UPDATED:
        this.applyPermissions(message.permissions);
        return;
      case ServerMessageType.PARTICIPANT_UPDATED: {
        const target = message.participantId === this.localParticipant.identity ? this.localParticipant : this.remoteParticipants.get(message.participantId);
        if (target) {
          this.applyParticipantMetadata(target, message);
        }
        return;
      }
      case ServerMessageType.DATA_THROTTLED: {
        const channel = message.channel === "lossy" ? "lossy" : "reliable";
        this.logger.warn(`data messages throttled by the server (${channel} channel); some were dropped`);
        this.emit("dataThrottled", channel);
        return;
      }
      case ServerMessageType.TRANSCRIPTION_SEGMENT: {
        const segment = parseTranscriptionSegment(message);
        if (segment) {
          this.emit("transcriptionSegment", segment);
        }
        return;
      }
      case ServerMessageType.TRANSCRIPTION_STATE: {
        const state = parseTranscriptionState(message);
        if (state) {
          this.emit("transcriptionStateChanged", state);
        }
        return;
      }
      case ServerMessageType.AGENT_STATE:
        this.applyAgentState(message.participantId, message.state);
        return;
      case ServerMessageType.TRACK_PUBLISHED:
        this.announceTrack(message.participantId, message.track);
        return;
      case ServerMessageType.TRACK_UNPUBLISHED: {
        const key = subscriptionKey(message.participantId, message.trackId);
        this.announcedTracks.delete(key);
        this.pendingMedia.delete(key);
        this.pendingSubscriptionStates.delete(key);
        const subscription = this.subscribed.get(key);
        const participant = this.remoteParticipants.get(message.participantId);
        if (subscription && participant) {
          this.subscribed.delete(key);
          this.emit("trackUnpublished", subscription.track.kind, participant);
          this.emit("trackUnsubscribed", subscription.track, participant);
        }
        return;
      }
      case ServerMessageType.TRACK_MUTED:
      case ServerMessageType.TRACK_UNMUTED: {
        const muted = message.type === ServerMessageType.TRACK_MUTED;
        if (muted && "byServer" in message && message.byServer === true && message.participantId === this.localParticipant.identity) {
          await this.applyServerMute(message.trackId);
          return;
        }
        const key = subscriptionKey(message.participantId, message.trackId);
        const subscription = this.subscribed.get(key);
        const participant = this.remoteParticipants.get(message.participantId);
        if (!subscription || !participant) {
          return;
        }
        subscription.delegate.setPublisherMuted(muted);
        this.emit(muted ? "trackMuted" : "trackUnmuted", subscription.track.kind, participant);
        return;
      }
      case ServerMessageType.CONNECTION_STATE:
        this.sfuIceState = message.iceState;
        this.sfuPeerState = message.peerState;
        this.logger.debug("sfu connection state", message.iceState, message.peerState);
        return;
      case ServerMessageType.SPEAKERS_CHANGED:
        this.applySpeakers(message.speakers);
        return;
      case ServerMessageType.QUALITY_CHANGED:
        this.applyQualityUpdates(message.updates);
        return;
      case ServerMessageType.SUBSCRIPTION_STATE:
        this.applySubscriptionState(message);
        return;
      case ServerMessageType.PUBLISHER_LAYERS:
        this.applyPublisherLayers(message.trackId, message.layers);
        return;
      case ServerMessageType.ERROR:
        if (message.code === "NEGOTIATION_GLARE") {
          this.logger.debug("sfu refused our offer as glare; waiting for its offer");
          return;
        }
        this.emit("mediaError", new Error(message.message));
        return;
      default:
        return;
    }
  }
  /** Phase 7 §2: applies metadata/attributes and emits `participantMetadataChanged` when they changed. */
  applyParticipantMetadata(participant, update) {
    const prev = participant._applyMetadata({ metadata: update.metadata, attributes: update.attributes });
    if (prev) {
      this.emit("participantMetadataChanged", participant, prev);
    }
  }
  // --- Phase 2: speakers, quality, subscription state ---------------------
  /** Any participant in the room by identity, this one included. */
  participantById(id) {
    if (id && id === this.localParticipant.identity) {
      return this.localParticipant;
    }
    return this.remoteParticipants.get(id);
  }
  /**
   * Applies the SFU's speaker set (§2). The list is the whole truth each
   * time: anyone missing from it has stopped speaking. Ids this client
   * does not know yet (a join still in flight) are skipped rather than
   * invented; the next update will include them if they are still talking.
   */
  applySpeakers(raw) {
    const entries = Array.isArray(raw) ? raw : [];
    const next = [];
    const levels = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      const id = entry?.participantId;
      const level = Number(entry?.level);
      if (typeof id !== "string") continue;
      const participant = this.participantById(id);
      if (!participant || levels.has(participant)) continue;
      levels.set(participant, Number.isFinite(level) ? level : 0);
      next.push(participant);
    }
    const previous = this._activeSpeakers;
    for (const participant of previous) {
      if (!levels.has(participant)) participant._setSpeaking(false, 0);
    }
    for (const participant of next) {
      participant._setSpeaking(true, levels.get(participant) ?? 0);
    }
    this._activeSpeakers = next;
    const same = previous.length === next.length && previous.every((participant, i) => participant === next[i]);
    if (!same) {
      this.emit("activeSpeakersChanged", [...next]);
    }
  }
  /** Applies per-participant connection scores (§3). Unknown names and ids are ignored. */
  applyQualityUpdates(raw) {
    const updates = Array.isArray(raw) ? raw : [];
    for (const update of updates) {
      const id = update?.participantId;
      const quality = update?.quality;
      if (typeof id !== "string" || typeof quality !== "string" || !SERVER_QUALITIES.has(quality)) continue;
      const participant = this.participantById(id);
      if (participant?._setConnectionQuality(quality)) {
        this.emit("connectionQualityChanged", participant, quality);
      }
    }
  }
  /** Applies a subscription's forwarding state (§4), or parks it until the track exists. */
  applySubscriptionState(message) {
    if (typeof message.publisherId !== "string" || typeof message.trackId !== "string") return;
    if (!SUBSCRIPTION_STATES.has(message.state)) return;
    const state = message.state;
    const layer = typeof message.layer === "string" && FORWARDED_LAYERS.has(message.layer) ? message.layer : void 0;
    const key = subscriptionKey(message.publisherId, message.trackId);
    const subscription = this.subscribed.get(key);
    if (!subscription) {
      this.pendingSubscriptionStates.set(key, { state, layer });
      return;
    }
    const participant = this.remoteParticipants.get(subscription.participantId);
    if (subscription.track._setSubscriptionState(state, layer) && participant) {
      this.emit("trackSubscriptionStateChanged", subscription.track, participant);
    }
  }
  /** Forgets speaker and quality state that only meant something on the session that ended. */
  resetRoomSignals() {
    for (const participant of this._activeSpeakers) {
      participant._setSpeaking(false, 0);
    }
    this._activeSpeakers = [];
    this.localParticipant._setConnectionQuality("unknown");
    this.pendingSubscriptionStates.clear();
  }
  // --- Phase 2: dynacast (publisher.layers) ------------------------------
  /**
   * Turns simulcast encodings on and off to match what subscribers are
   * actually receiving (§5). An encoding nobody receives is CPU and uplink
   * spent on nothing; on a laptop with the camera at three layers that is
   * the difference between a fan that spins and one that does not.
   *
   * A frame for a track this participant does not publish, or one naming
   * no RID the sender negotiated, changes nothing. A client that never
   * applies these keeps sending every layer, which is the old behaviour,
   * so every failure here is logged and swallowed rather than surfaced.
   */
  applyPublisherLayers(trackId, layers) {
    if (typeof trackId !== "string" || !Array.isArray(layers)) return;
    const entry = [...this.published.entries()].find(
      ([, publication]) => publication.trackId === trackId || publication.track.mediaStreamTrack.id === trackId
    );
    if (!entry) {
      this.logger.debug("publisher.layers for a track we do not publish", trackId);
      return;
    }
    const [kind] = entry;
    const activity = /* @__PURE__ */ new Map();
    for (const layer of layers) {
      const rid = layer?.rid;
      const active = layer?.active;
      if (typeof rid === "string" && typeof active === "boolean") {
        activity.set(rid, active);
      }
    }
    this.layerActivity.set(kind, activity);
    this.applyLayerActivity(kind);
  }
  /** Queues the desired encoding activity for one publication onto its sender. */
  applyLayerActivity(kind) {
    const activity = this.layerActivity.get(kind);
    const sender = this.published.get(kind)?.sender;
    if (!activity || activity.size === 0 || !sender) return;
    const previous = this.senderParameterChains.get(sender) ?? Promise.resolve();
    const run = previous.then(() => this.setEncodingActivity(sender, activity, kind));
    this.senderParameterChains.set(
      sender,
      run.catch(() => void 0)
    );
  }
  /**
   * One read-modify-write of a sender's parameters.
   *
   * `getParameters()` is read inside the queued task, never ahead of it:
   * `setParameters` must be handed the transaction from the most recent
   * read, and a read taken before an earlier write finished is exactly the
   * stale transaction it rejects. Skipped entirely when nothing would
   * change, so a repeated frame costs no encoder reconfiguration.
   */
  async setEncodingActivity(sender, activity, kind) {
    if (this.published.get(kind)?.sender !== sender) return;
    let parameters;
    try {
      parameters = sender.getParameters();
    } catch (error) {
      this.logger.debug("could not read sender parameters for dynacast", error.message);
      return;
    }
    const encodings = parameters.encodings ?? [];
    let changed = false;
    for (const encoding of encodings) {
      const rid = encoding.rid;
      if (!rid) continue;
      const wanted = activity.get(rid) ?? (RID_ALIASES[rid] ? activity.get(RID_ALIASES[rid]) : void 0);
      if (wanted === void 0 || (encoding.active ?? true) === wanted) continue;
      encoding.active = wanted;
      changed = true;
    }
    if (!changed) return;
    try {
      await sender.setParameters(parameters);
      this.logger.debug(
        "dynacast applied",
        kind,
        encodings.map((encoding) => `${encoding.rid}:${encoding.active === false ? "off" : "on"}`).join(" ")
      );
    } catch (error) {
      this.logger.debug("dynacast setParameters failed", error.message);
    }
  }
  // --- Negotiation -------------------------------------------------------
  ensurePeerConnection() {
    if (this.pc) {
      return this.pc;
    }
    const pcConfig = { iceServers: this.iceServers };
    if (this.e2ee?.needsInsertableStreams) {
      pcConfig.encodedInsertableStreams = true;
    }
    const pc = new RTCPeerConnection(pcConfig);
    this.pc = pc;
    this.simulcastTransceivers.clear();
    this.sentLayers.clear();
    pc.onicecandidate = (event) => {
      if (!event.candidate) {
        return;
      }
      this.signaling?.send({
        type: ClientMessageType.ICE_CANDIDATE,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid ?? void 0,
        sdpMLineIndex: event.candidate.sdpMLineIndex ?? void 0,
        usernameFragment: event.candidate.usernameFragment ?? void 0
      });
    };
    pc.onconnectionstatechange = () => {
      this.logger.debug("peer connection state", pc.connectionState);
      switch (pc.connectionState) {
        case "connected":
          this.mediaRejoinAttempts = 0;
          if (this.signaling?.isJoined) {
            this.setConnectionState("connected");
          }
          break;
        case "failed":
          if (!this.autoReconnect) {
            this._lastDisconnect = {
              reason: "CONNECTION_FAILED",
              error: new RTCError("CONNECTION_FAILED", "The media connection failed")
            };
            this.setConnectionState("failed");
            break;
          }
          this.setConnectionState("reconnecting");
          this.scheduleMediaRejoin();
          break;
      }
    };
    pc.onnegotiationneeded = () => {
      this.logger.debug("browser reports negotiation needed");
      this.negotiationNeeded = true;
      this.scheduleNegotiation();
    };
    pc.ontrack = (event) => this.handleIncomingTrack(event);
    pc.ondatachannel = (event) => {
      if (event.channel.label === LOSSY_DATA_CHANNEL_LABEL) {
        this.attachLossyChannel(event.channel);
        return;
      }
      if (event.channel.label !== DATA_CHANNEL_LABEL) {
        return;
      }
      this.attachDataChannel(event.channel);
    };
    return pc;
  }
  /**
   * Runs `task` after everything already queued, and before anything
   * queued later.
   *
   * The only way to touch this PeerConnection's signaling state. A failing
   * task must not wedge the chain, so the next one runs either way — the
   * caller still sees the rejection through the promise it holds.
   *
   * Nothing on this chain ever waits for the *peer*: each task does its
   * local half (apply a description, build an answer, send an offer) and
   * returns. Waiting for a reply while holding the chain would deadlock,
   * since the reply itself has to come through here.
   */
  enqueue(task) {
    const run = this.negotiationChain.then(task, task);
    this.negotiationChain = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  /**
   * Nudges the chain to look for work.
   *
   * Does not decide that an offer is needed — `negotiationneeded` does
   * that. Used where a round has just ended, or where a local change has
   * been made and the browser's event may already have fired.
   */
  scheduleNegotiationIfNeeded() {
    if (this.negotiationNeeded || this.publishedTracksMissingFromSdp()) {
      this.scheduleNegotiation();
    }
  }
  scheduleNegotiation() {
    if (this.negotiationScheduled) {
      return;
    }
    this.negotiationScheduled = true;
    void this.enqueue(async () => {
      this.negotiationScheduled = false;
      await this.runNegotiation();
    });
  }
  /**
   * Offers, if there is anything to offer and the connection can take one.
   *
   * Runs on the chain, so `signalingState` cannot change under it between
   * the check and `setLocalDescription`.
   */
  async runNegotiation() {
    const pc = this.pc;
    const signaling = this.signaling;
    if (!pc || !signaling) {
      return;
    }
    if (!this.negotiationNeeded && !this.publishedTracksMissingFromSdp()) {
      return;
    }
    if (pc.signalingState !== "stable") {
      this.logger.debug("negotiation deferred until the current round ends", pc.signalingState);
      return;
    }
    this.negotiationNeeded = false;
    const iceRestart = this.iceRestartRequested;
    this.iceRestartRequested = false;
    try {
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : void 0);
      await pc.setLocalDescription(offer);
      for (const entry of this.published.values()) {
        if (entry.sender) {
          this.msidRefreshAttempted.add(entry.trackId);
        }
      }
      this.reconcilePublicationIds(pc);
      this.confirmSimulcastStatus();
      this.e2ee?.updatePayloadTypes(pc.localDescription?.sdp, pc.remoteDescription?.sdp);
      signaling.send({
        type: ClientMessageType.SDP_OFFER,
        sdp: pc.localDescription?.sdp ?? offer.sdp ?? ""
      });
    } catch (error) {
      this.negotiationNeeded = true;
      this.iceRestartRequested = this.iceRestartRequested || iceRestart;
      this.logger.error("could not offer", error.message);
      this.emit("mediaError", new RTCError("MEDIA_ERROR", "Could not negotiate the published track", error));
    }
  }
  /**
   * Answers the SFU.
   *
   * Rolls our own offer back first if one is outstanding. RFC-wise either
   * peer may offer, and something has to break the tie; the SFU is the one
   * with the room-wide view, so it wins and our change is re-queued rather
   * than dropped.
   */
  async applyRemoteOffer(sdp) {
    const pc = this.ensurePeerConnection();
    try {
      if (pc.signalingState === "have-local-offer") {
        this.logger.debug("glare: rolling our offer back and answering the sfu");
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch (error) {
          this.logger.debug("explicit rollback unavailable", error.message);
        }
      }
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.reconcilePublicationIds(pc);
      this.confirmSimulcastStatus();
      this.e2ee?.updatePayloadTypes(pc.localDescription?.sdp, pc.remoteDescription?.sdp);
      this.signaling?.send({
        type: ClientMessageType.SDP_ANSWER,
        sdp: pc.localDescription?.sdp ?? answer.sdp ?? ""
      });
    } catch (error) {
      this.logger.error("failed to answer offer", error.message);
      const reason = error instanceof Error ? error.message : String(error);
      this.emit("mediaError", new Error(`Could not answer the server's offer: ${reason}`));
      return;
    }
    this.afterRoundTrip();
  }
  async applyRemoteAnswer(sdp) {
    const pc = this.pc;
    if (!pc) {
      return;
    }
    if (pc.signalingState !== "have-local-offer") {
      this.logger.debug("discarding an answer for a superseded offer", pc.signalingState);
      this.afterRoundTrip();
      return;
    }
    try {
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (error) {
      this.logger.error("failed to apply answer", error.message);
    }
    this.afterRoundTrip();
  }
  async applyRemoteCandidate(message) {
    if (!this.pc) {
      return;
    }
    try {
      await this.pc.addIceCandidate({
        candidate: message.candidate,
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex,
        usernameFragment: message.usernameFragment
      });
    } catch (error) {
      this.logger.debug("ignoring ICE candidate", error.message);
    }
  }
  /**
   * A round ended: offer again if anything still needs one.
   *
   * Two things can: the browser's own negotiation-needed bit, and Swalvo's
   * requirement that our published tracks appear in the local description
   * by their real ids. See `publishedTracksMissingFromSdp()`.
   */
  afterRoundTrip() {
    if (this.publishedTracksMissingFromSdp()) {
      this.negotiationNeeded = true;
    }
    for (const kind of this.layerActivity.keys()) {
      this.applyLayerActivity(kind);
    }
    this.scheduleNegotiationIfNeeded();
  }
  /**
   * Whether some published track's id is absent from the local
   * description's `a=msid:` lines.
   *
   * Swalvo's SFU identifies a published track by the id in the SDP `msid`
   * and matches it against the `track.publish` declaration that says
   * whether it is a camera or a screen share. So it is not enough for the
   * track to be *sending*: our id has to be the one on the wire.
   *
   * It is possible for it not to be. The SFU pre-creates a receive slot
   * for a declared track, and `addTrack` reuses that transceiver; if the
   * SFU's own next offer then covers the m-line, the browser's
   * negotiation-needed bit clears with the SFU's msid still in place. RTP
   * flows — the SFU just has no idea which of our tracks it belongs to,
   * and falls back to guessing from the codec kind. A camera guessed as a
   * camera hides it; a screen share guessed as a camera puts somebody's
   * shared window in the face tile.
   *
   * Checking the SDP rather than trusting a flag is what makes this
   * terminate: one offer of ours puts every id in place, and the answer to
   * the next check is no.
   */
  publishedTracksMissingFromSdp() {
    const pc = this.pc;
    if (!pc || this.published.size === 0) {
      return false;
    }
    const sdp = pc.localDescription?.sdp;
    if (!sdp) {
      return false;
    }
    const announced = /* @__PURE__ */ new Set();
    for (const line of sdp.split(/\r?\n/)) {
      if (!line.startsWith("a=msid:")) {
        continue;
      }
      const trackId = line.slice("a=msid:".length).trim().split(/\s+/)[1];
      if (trackId) {
        announced.add(trackId);
      }
    }
    for (const entry of this.published.values()) {
      if (!entry.sender || announced.has(entry.trackId)) {
        continue;
      }
      if (this.msidRefreshAttempted.has(entry.trackId)) {
        this.logger.warn(
          "published track is not announced by its own id; the sfu will guess its source",
          entry.trackId
        );
        continue;
      }
      this.logger.debug("published track missing from the local sdp", entry.trackId);
      return true;
    }
    return false;
  }
  /**
   * Resolves when the data channel is open.
   *
   * What `sendData()` actually needs to wait for. Waiting on "negotiation
   * has gone quiet" instead resolves a beat too early — the browser raises
   * `negotiationneeded` on a task, so a connection looks quiet for one
   * turn after the channel was created — and the caller would be told its
   * payload had gone out while it was still queued.
   */
  dataChannelOpened() {
    if (this.dataChannel?.readyState === "open") {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.dataChannelWaiters.push({ resolve, reject });
    });
  }
  settleDataChannel() {
    const waiters = this.dataChannelWaiters;
    if (waiters.length === 0) {
      return;
    }
    this.dataChannelWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }
  /**
   * Fails everyone waiting on the data channel, because it is never going
   * to open.
   *
   * Only for a connection that is finished — a terminal failure or a
   * deliberate leave. A reconnect deliberately does *not* come through
   * here: rejoining re-creates the channel and settles the wait, so a
   * `sendData()` made mid-blip still goes out afterwards rather than
   * throwing at the caller.
   */
  abortDataChannelWaiters(reason) {
    const waiters = this.dataChannelWaiters;
    if (waiters.length === 0) {
      return;
    }
    this.dataChannelWaiters = [];
    const error = new RTCError("CONNECTION_FAILED", reason);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
  // --- Incoming media ----------------------------------------------------
  /**
   * Matches an arriving track up with whatever signaling said about it.
   *
   * The SFU forwards every subscription carrying the *publisher's* track id
   * as the SDP `msid` track id, and that's what makes attribution possible
   * without a side channel. `ontrack` and `track.published` race, so this
   * only completes a subscription when both halves are in, parking
   * whichever showed up first.
   *
   * # Why the id comes from the SDP, not the track
   *
   * `RTCTrackEvent.track.id` is **not** the remote track id. Chrome mints
   * a brand-new local id for a received track and pays no attention to the
   * `msid`; the id in `a=msid:<stream> <track>` is the remote one. So
   * matching on `event.track.id` never matched anything, ever. And because
   * the unmatched track got parked as "media arrived early", it failed in
   * total silence: a subscription that simply never completed, not an
   * error anybody could see. Reading the `msid` is the standards-defined
   * way to get the id the remote peer actually picked.
   */
  handleIncomingTrack(event) {
    this.e2ee?.setupReceiver(event.receiver, event.track.kind === "audio" ? "audio" : "video");
    const [stream] = event.streams;
    const trackId = this.remoteTrackIdFor(event) ?? event.track.id;
    const announcement = this.findAnnouncementForTrack(trackId);
    if (!announcement) {
      this.logger.debug(
        "media arrived before its announcement",
        `resolved=${trackId}`,
        `local=${event.track.id}`,
        `stream=${stream?.id ?? "none"}`,
        `mid=${event.transceiver?.mid ?? "none"}`,
        `announced=[${Array.from(this.announcedTracks.values()).map((entry) => `${entry.participantId}:${entry.track.trackId}`).join(", ")}]`
      );
      this.pendingMedia.set(pendingKey(trackId), {
        stream: stream ?? new MediaStream([event.track]),
        track: event.track,
        receiver: event.receiver
      });
      return;
    }
    this.completeSubscription(announcement.participantId, announcement.track, event.track, event.receiver);
  }
  /**
   * The remote track id for an arriving track, read out of the remote SDP.
   *
   * Found via the transceiver's `mid` rather than by scanning every
   * `a=msid:` line. Someone publishing both a camera and a screen share
   * has two video m-sections, and picking the wrong one labels a screen
   * share as somebody's face.
   *
   * Returns undefined when the SDP doesn't say, either an `msid`-less
   * offer or a transceiver with no mid yet, so the caller can fall back
   * instead of guessing.
   */
  remoteTrackIdFor(event) {
    const mid = event.transceiver?.mid;
    const sdp = this.pc?.remoteDescription?.sdp;
    if (!mid || !sdp) {
      return void 0;
    }
    return msidTrackIdForMid(sdp, mid);
  }
  findAnnouncementForTrack(trackId) {
    for (const announcement of this.announcedTracks.values()) {
      if (announcement.track.trackId === trackId) {
        return announcement;
      }
    }
    return void 0;
  }
  announceTrack(participantId, track) {
    const key = subscriptionKey(participantId, track.trackId);
    this.announcedTracks.set(key, { participantId, track });
    this.logger.debug("track announced", `${participantId}:${track.trackId}`, track.kind, track.source);
    const participant = this.remoteParticipants.get(participantId);
    if (participant) {
      this.emit("trackPublished", trackKindFromSource(track.source, track.kind), participant);
    }
    const pending = this.pendingMedia.get(pendingKey(track.trackId));
    if (pending) {
      this.pendingMedia.delete(pendingKey(track.trackId));
      this.completeSubscription(participantId, track, pending.track, pending.receiver);
    }
  }
  completeSubscription(participantId, serverTrack, mediaStreamTrack, receiver) {
    const participant = this.remoteParticipants.get(participantId);
    if (!participant) {
      this.logger.debug("track for an unknown participant", participantId);
      return;
    }
    const key = subscriptionKey(participantId, serverTrack.trackId);
    if (this.subscribed.has(key)) {
      return;
    }
    this.e2ee?.setupReceiver(receiver, serverTrack.kind, participantId);
    const delegate = new NativeRemoteTrackDelegate(mediaStreamTrack, receiver);
    delegate.setPublisherMuted(serverTrack.muted);
    const kind = trackKindFromSource(serverTrack.source, serverTrack.kind);
    const track = new RemoteTrack(delegate, kind);
    const isVideo = serverTrack.kind === "video";
    const parked = this.pendingSubscriptionStates.get(key);
    this.pendingSubscriptionStates.delete(key);
    if (parked) {
      track._setSubscriptionState(parked.state, parked.layer);
    } else if (isVideo && !this.autoSubscribe) {
      track._setSubscriptionState("paused_client", "off");
    }
    const subscription = { track, delegate, participantId, trackId: serverTrack.trackId, hidden: false };
    this.subscribed.set(key, subscription);
    this.attachLayerControl(track, key);
    participant.tracks.push(track);
    this.emit("trackSubscribed", track, participant);
    if (isVideo && (this.pinnedLayers.has(key) || this.disabledTracks.has(key))) {
      if (this.disabledTracks.has(key)) track["_enabled"] = false;
      this.sendEffectiveLayer(subscription);
    }
    mediaStreamTrack.onended = () => {
      const subscription2 = this.subscribed.get(key);
      if (!subscription2) {
        return;
      }
      this.subscribed.delete(key);
      this.adaptiveControllers.get(key)?.dispose();
      this.adaptiveControllers.delete(key);
      this.pinnedLayers.delete(key);
      this.disabledTracks.delete(key);
      this.sentLayers.delete(key);
      const index = participant.tracks.indexOf(subscription2.track);
      if (index !== -1) {
        participant.tracks.splice(index, 1);
      }
      this.emit("trackUnsubscribed", subscription2.track, participant);
    };
  }
  // --- Publishing --------------------------------------------------------
  async enableCamera(enabled) {
    return enabled ? this.publishKind("camera", () => createCameraTrack()) : this.unpublishKind("camera");
  }
  async enableMicrophone(enabled) {
    return enabled ? this.publishKind("microphone", () => createMicrophoneTrack()) : this.unpublishKind("microphone");
  }
  /**
   * With `audio: true`, also publishes whatever audio the browser hands back
   * (Chrome: a tab, or the whole system on Windows/ChromeOS) as a second
   * track with source `screenShareAudio` (phase7-contracts §3). No audio
   * track simply means video only. Unpublishing the screen share, by any
   * route, unpublishes both — see `unpublish()`.
   */
  async enableScreenShare(enabled, options = {}) {
    if (!enabled) {
      return this.unpublishKind("screenShare");
    }
    let audio;
    const video = await this.publishKind("screenShare", async () => {
      const captured = await createScreenShareTracks({ audio: options.audio === true });
      audio = captured.audio;
      return captured.video;
    });
    const audioTrack = audio;
    if (audioTrack) {
      try {
        await this.withKindLock("screenShareAudio", async () => {
          const existing = this.published.get("screenShareAudio");
          if (existing) {
            await this.unpublish(existing.track);
          }
          if (this.published.get("screenShare")?.track !== video) {
            audioTrack.mediaStreamTrack.stop();
            return;
          }
          await this.publish(audioTrack);
        });
      } catch (error) {
        audioTrack.mediaStreamTrack.stop();
        this.logger.warn("could not publish the screen-share audio; sharing video only", error.message);
        this.emit("mediaError", error instanceof Error ? error : new Error(String(error)));
      }
    }
    return video;
  }
  /**
   * Serializes enable/disable per kind.
   *
   * Two `enableCamera()` calls in flight at once used to mean two
   * `getUserMedia` prompts, two senders and one of them orphaned in the
   * `published` map. Callers that overlap now share the first call's
   * result. Per kind rather than global, so a microphone does not queue
   * behind a camera's device prompt.
   */
  async withKindLock(kind, operation) {
    const previous = this.kindOperations.get(kind) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.kindOperations.set(
      kind,
      run.then(
        () => void 0,
        () => void 0
      )
    );
    return run;
  }
  async publishKind(kind, capture) {
    return this.withKindLock(kind, () => this.publishKindLocked(kind, capture));
  }
  async publishKindLocked(kind, capture) {
    const existing = this.published.get(kind);
    if (existing) {
      await existing.track.unmute();
      this.signaling?.send({
        type: ClientMessageType.TRACK_MUTE,
        trackId: existing.trackId,
        muted: false
      });
      return existing.track;
    }
    this.assertMayPublishMedia();
    const track = await capture();
    await this.publish(track);
    return track;
  }
  async unpublishKind(kind) {
    return this.withKindLock(kind, async () => {
      const existing = this.published.get(kind);
      if (!existing) {
        return void 0;
      }
      await this.unpublish(existing.track);
      return void 0;
    });
  }
  async publish(track) {
    const delegate = track["delegate"];
    if (!(delegate instanceof NativeLocalTrackDelegate)) {
      throw new RTCError(
        "MEDIA_ERROR",
        "This track was not created by the Swalvo SDK. Wrap your own MediaStreamTrack with createCustomTrack() (or client.createCustomTrack()) before publishing it"
      );
    }
    this.assertMayPublishMedia();
    this.published.set(track.kind, {
      track,
      delegate,
      trackId: track.mediaStreamTrack.id,
      // Nothing is claimed until negotiation has been read back.
      simulcast: kindUsesSimulcast(track.kind) ? "pending" : "notApplicable"
    });
    if (!this.localParticipant.tracks.includes(track)) {
      this.localParticipant.tracks.push(track);
    }
    try {
      await this.attachToPeerConnection(track.kind);
    } catch (error) {
      this.published.delete(track.kind);
      const index = this.localParticipant.tracks.indexOf(track);
      if (index !== -1) {
        this.localParticipant.tracks.splice(index, 1);
      }
      throw error;
    }
    this.emit("localTrackPublished", track);
  }
  /**
   * Puts one desired publication onto the current PeerConnection.
   *
   * Everything the SFU needs to know about a track lives here, so the
   * first publish and a post-reconnect restore go through exactly the same
   * code and cannot drift apart. Idempotent: a track already carried by a
   * sender on this connection is left alone, which is what stops a re-sent
   * room state from adding a second sender for the same camera.
   */
  async attachToPeerConnection(kind) {
    const entry = this.published.get(kind);
    if (!entry) {
      return;
    }
    const pc = this.ensurePeerConnection();
    const mediaStreamTrack = entry.track.mediaStreamTrack;
    const alreadyAttached = pc.getSenders().find((sender2) => sender2.track !== null && sender2.track === mediaStreamTrack);
    if (alreadyAttached) {
      entry.sender = alreadyAttached;
      entry.delegate.setSender(alreadyAttached);
      this.e2ee?.setupSender(alreadyAttached, mediaStreamTrack.kind === "audio" ? "audio" : "video");
      return;
    }
    const stream = typeof MediaStream !== "undefined" ? new MediaStream([mediaStreamTrack]) : void 0;
    const attached = this.attachSender(pc, kind, mediaStreamTrack, stream);
    const sender = attached.sender;
    if (attached.transceiver) {
      this.simulcastTransceivers.set(kind, attached.transceiver);
    }
    entry.simulcast = attached.simulcast;
    const source = declaredSourceFor(kind);
    if (source) {
      this.signaling?.send({
        type: ClientMessageType.TRACK_PUBLISH,
        trackId: mediaStreamTrack.id,
        source
      });
    }
    entry.sender = sender;
    entry.trackId = mediaStreamTrack.id;
    entry.delegate.setSender(sender);
    this.e2ee?.setupSender(sender, mediaStreamTrack.kind === "audio" ? "audio" : "video");
    this.layerActivity.delete(kind);
    mediaStreamTrack.onended = () => {
      void this.unpublish(entry.track).catch(() => void 0);
    };
    this.scheduleNegotiationIfNeeded();
  }
  /**
   * Makes the publication ids we told the SFU match the ids on the wire.
   *
   * A publication's identity in this protocol is the track id in the SDP
   * `a=msid:` line. The SFU keys everything on it — the published-track
   * map, the `track.publish` source declaration, mute lookups, and the id
   * it announces to subscribers — and it reads that id off the RTP stream
   * as `TrackRemote.ID()`. Nothing else in the exchange identifies a
   * publication, which is why the id has to be right rather than merely
   * plausible.
   *
   * It was not always right. The SFU pre-creates one recvonly audio and
   * one recvonly video transceiver for every subscribing participant, so
   * that a first publish costs no extra renegotiation. `addTrack` reuses
   * those, and the m-section can keep the msid it already had —
   * Chrome will not rewrite an id it did not author. So the SFU received a
   * stream announcing one id while the declaration named another, found no
   * match, and fell back to inferring the source from the codec kind:
   * right for a camera, right for a microphone, and wrong for a screen
   * share, which then arrives labelled `camera` and lands in the face tile
   * of every layout keyed on source.
   *
   * The fix is to read what the browser actually wrote and declare that.
   * Called immediately after our own `setLocalDescription` and before the
   * description goes out, so the corrected declaration reaches the SFU
   * ahead of the media it describes — same socket, so ordering holds
   * without waiting for anything.
   *
   * No SDP is rewritten and no identifier is invented: this is the
   * protocol's existing publication id, finally taken from the one place
   * that knows it.
   */
  reconcilePublicationIds(pc) {
    const sdp = pc.localDescription?.sdp;
    if (!sdp || this.published.size === 0) {
      return;
    }
    for (const [kind, entry] of this.published) {
      if (!entry.sender) {
        continue;
      }
      const mid = pc.getTransceivers().find((t) => t.sender === entry.sender)?.mid;
      if (!mid) {
        continue;
      }
      const onTheWire = msidTrackIdForMid(sdp, mid);
      if (!onTheWire || onTheWire === entry.trackId) {
        continue;
      }
      this.logger.debug(
        "publication id corrected from the sdp",
        `${kind}: ${entry.trackId} -> ${onTheWire} (mid ${mid})`
      );
      entry.trackId = onTheWire;
      const source = declaredSourceFor(kind);
      if (source) {
        this.signaling?.send({
          type: ClientMessageType.TRACK_PUBLISH,
          trackId: onTheWire,
          source
        });
      }
    }
  }
  /**
   * Re-publishes everything this participant wants published onto a
   * replacement PeerConnection.
   *
   * Runs on every join, so a reconnect restores the microphone, camera and
   * screen share that were live before the outage — in one renegotiation,
   * because every `addTrack` here lands before the browser's queued
   * `negotiationneeded` task runs.
   *
   * A screen share is the one case where desired state can have expired
   * while we were away: ending the share is the user's own doing, through
   * browser UI Swalvo never sees, and its track is dead for good. Restoring
   * a dead track would publish an m-section that never carries a frame, so
   * it is dropped and the room is told, exactly as if the user had stopped
   * sharing while connected.
   */
  restoreLocalPublications() {
    if (this.dataChannelWanted && !this.dataChannel) {
      this.openDataChannel();
    }
    if (this.supportsDataV2 && (this.lossyChannelWanted || this.dataChannelWanted) && !this.lossyChannel) {
      this.openLossyChannel();
    }
    this.msidRefreshAttempted.clear();
    for (const [kind, entry] of [...this.published]) {
      if (entry.track.mediaStreamTrack.readyState === "ended") {
        this.logger.debug("dropping a publication whose source has ended", kind);
        this.published.delete(kind);
        const index = this.localParticipant.tracks.indexOf(entry.track);
        if (index !== -1) {
          this.localParticipant.tracks.splice(index, 1);
        }
        entry.sender = void 0;
        entry.delegate.setSender(void 0);
        this.emit("localTrackUnpublished", entry.track);
        continue;
      }
      entry.sender = void 0;
      entry.delegate.setSender(void 0);
      void this.attachToPeerConnection(kind).catch((error) => {
        this.logger.error("could not restore a publication", kind, error.message);
        this.emit("mediaError", error instanceof Error ? error : new Error(String(error)));
      });
    }
  }
  async unpublish(track) {
    const entry = this.published.get(track.kind);
    if (!entry || entry.track !== track) {
      return;
    }
    this.published.delete(track.kind);
    this.layerActivity.delete(track.kind);
    const index = this.localParticipant.tracks.indexOf(track);
    if (index !== -1) {
      this.localParticipant.tracks.splice(index, 1);
    }
    entry.delegate.setSender(void 0);
    if (entry.sender) {
      const simulcast = this.simulcastTransceivers.get(track.kind);
      if (simulcast?.sender === entry.sender && typeof simulcast.stop === "function") {
        this.simulcastTransceivers.delete(track.kind);
        try {
          simulcast.stop();
        } catch (error) {
          this.logger.debug("stopping the simulcast transceiver failed", error.message);
        }
      } else {
        try {
          this.pc?.removeTrack(entry.sender);
        } catch (error) {
          this.logger.debug("removeTrack failed", error.message);
        }
      }
      entry.sender = void 0;
    }
    this.msidRefreshAttempted.delete(entry.trackId);
    track.mediaStreamTrack.onended = null;
    track.mediaStreamTrack.stop();
    this.emit("localTrackUnpublished", track);
    if (track.kind === "screenShare") {
      const companion = this.published.get("screenShareAudio");
      if (companion) {
        await this.unpublish(companion.track);
      }
    }
  }
  /**
   * Puts a local track on the connection, with a simulcast ladder when the
   * kind calls for one.
   *
   * # Why this is not `addTrack`
   *
   * `addTrack` returns a sender with exactly one encoding, and the number
   * of encodings on a sender is fixed for its lifetime — `setParameters` is
   * specified to reject any change to it. RIDs also only reach the SDP when
   * they were present before the offer was generated. So the ladder has to
   * be declared at the moment the transceiver is created and can never be
   * added afterwards, which is precisely what the previous `addTrack` +
   * `setParameters` pair attempted, failed at, and logged at debug level.
   *
   * # The comment this replaces
   *
   * The old code explained that `addTransceiver` was not shipped "because
   * this SFU does not answer a client offer that adds m-sections". That was
   * not true, or is no longer: `Participant.AcceptOffer`
   * (`services/sfu/internal/room/participant.go`) does a plain
   * `SetRemoteDescription` + `CreateAnswer` and rejects only on glare,
   * which is retryable. The Flutter SDK has relied on that path for its
   * first publish of every kind. It is verified end to end by
   * `services/sfu/internal/room/simulcast_integration_test.go`, where a
   * client-offered simulcast m-section is answered with
   * `a=simulcast:recv low;medium;high`.
   *
   * # What it reuses
   *
   * Not the SFU's pre-created recvonly transceivers — those exist with one
   * encoding and can never carry a ladder. A transceiver of its own that is
   * still live on this connection is reused; one that was unpublished has
   * been stopped (see `unpublish`), so a re-enabled camera gets a fresh
   * transceiver and the SFU sees a genuinely new track. Its m-section is
   * recycled from the stopped one, so toggling does not grow the SDP.
   */
  attachSender(pc, kind, mediaStreamTrack, stream) {
    if (!kindUsesSimulcast(kind)) {
      return { sender: this.addPlainTrack(pc, mediaStreamTrack, stream), simulcast: "notApplicable" };
    }
    const existing = this.simulcastTransceivers.get(kind);
    if (existing && existing.sender && pc.getTransceivers().includes(existing)) {
      try {
        void existing.sender.replaceTrack(mediaStreamTrack);
        existing.direction = "sendonly";
        return {
          sender: existing.sender,
          transceiver: existing,
          simulcast: confirmSimulcast(existing.sender).status
        };
      } catch (error) {
        this.logger.debug("reusing the simulcast transceiver failed", error.message);
        this.simulcastTransceivers.delete(kind);
      }
    }
    const codec = this.effectiveVideoCodec();
    if (codec === "vp9" || codec === "av1") {
      try {
        const transceiver = pc.addTransceiver(mediaStreamTrack, {
          direction: "sendonly",
          streams: stream ? [stream] : [],
          sendEncodings: svcSendEncodings()
        });
        this.applyCodecPreference(transceiver, codec);
        return { sender: transceiver.sender, transceiver, simulcast: "pending" };
      } catch (error) {
        this.svcRefused = true;
        this.logger.warn(`this browser refused ${codec} SVC; publishing VP8 simulcast instead`, error.message);
      }
    }
    try {
      const transceiver = pc.addTransceiver(mediaStreamTrack, {
        direction: "sendonly",
        streams: stream ? [stream] : [],
        sendEncodings: simulcastSendEncodings()
      });
      this.applyCodecPreference(transceiver, this.effectiveVideoCodec());
      return { sender: transceiver.sender, transceiver, simulcast: "pending" };
    } catch (error) {
      this.logger.warn(
        "simulcast is unavailable in this browser: the camera will publish a single full-quality layer, so subscribers cannot drop to a cheaper one and a large call will cost every participant the full bitrate.",
        error.message
      );
      return { sender: this.addPlainTrack(pc, mediaStreamTrack, stream), simulcast: "unsupported" };
    }
  }
  /**
   * Puts the video codec (and its RTX) first in the offer. Best effort: a
   * browser without `setCodecPreferences`, or without the codec, publishes
   * with its own order, which only costs the live stream its
   * zero-transcode path.
   */
  applyCodecPreference(transceiver, codec) {
    if (!codec || typeof transceiver.setCodecPreferences !== "function") return;
    const ordered = videoCodecsPreferring(codec);
    if (!ordered) {
      this.logger.warn(`this browser cannot send ${codec}; publishing with its default codec order`);
      return;
    }
    try {
      transceiver.setCodecPreferences(ordered);
    } catch (error) {
      this.logger.debug("setCodecPreferences failed", error.message);
    }
  }
  /**
   * `videoCodec` as this browser can honour it: VP9/AV1 need L3T3_KEY SVC
   * (§2.2), and without it the camera falls back to VP8 simulcast rather
   * than a single-layer VP9 nobody can thin.
   */
  effectiveVideoCodec() {
    const codec = this.preferredVideoCodec;
    if ((codec === "vp9" || codec === "av1") && (this.svcRefused || !svcSupported(codec))) {
      return "vp8";
    }
    return codec;
  }
  /**
   * Opus with RED first (§2.1), unless E2EE is configured: Chrome hands the
   * frame transform the RED-wrapped payload, which no other platform's
   * frame cryptor would parse.
   */
  applyAudioRed(transceiver) {
    if (!this.audioRed || this.e2eeOptions || typeof transceiver.setCodecPreferences !== "function") return;
    const ordered = redFirstAudioCodecs();
    if (!ordered) return;
    try {
      transceiver.setCodecPreferences(ordered);
    } catch (error) {
      this.logger.debug("setCodecPreferences (red) failed", error.message);
    }
  }
  addPlainTrack(pc, mediaStreamTrack, stream) {
    try {
      const sender = stream ? pc.addTrack(mediaStreamTrack, stream) : pc.addTrack(mediaStreamTrack);
      const transceiver = pc.getTransceivers().find((t) => t.sender === sender);
      if (transceiver && mediaStreamTrack.kind === "video") {
        this.applyCodecPreference(transceiver, this.effectiveVideoCodec());
      } else if (transceiver && mediaStreamTrack.kind === "audio") {
        this.applyAudioRed(transceiver);
      }
      return sender;
    } catch (error) {
      throw new RTCError("MEDIA_ERROR", "Could not add the track to the connection", error);
    }
  }
  /**
   * Confirms the ladder after negotiation and reports what actually
   * happened.
   *
   * Called from the negotiation paths, once a local description exists:
   * before that the browser has not committed to a set of encodings.
   * Asking earlier is how the previous implementation convinced itself
   * simulcast was on — it read back an empty list, took an early return,
   * and never looked again.
   */
  confirmSimulcastStatus() {
    for (const [kind, entry] of this.published) {
      if (entry.simulcast !== "pending" || !entry.sender) continue;
      const { status, rids } = confirmSimulcast(entry.sender);
      entry.simulcast = status;
      if (status === "enabled") {
        this.logger.debug("simulcast active", `${kind}: ${rids.join(", ")}`);
        continue;
      }
      if (status === "svc") {
        this.logger.debug("svc active", kind);
        continue;
      }
      this.logger.warn(
        `simulcast did not survive negotiation for the ${kind} track: the sender reports [${rids.join(", ")}], expected [${SIMULCAST_LAYERS.map((l) => l.rid).join(", ")}]. Every subscriber will receive the one layer being sent.`
      );
    }
  }
  /**
   * Gives a newly subscribed track its layer control.
   *
   * The controller is created for video only. An audio track has no spatial
   * layers, and observing the `<audio>` element it is attached to would
   * produce a stream of size changes that mean nothing.
   */
  attachLayerControl(track, key) {
    if (trackKindToMediaKind(track.kind) === "audio") return;
    const controller = new AdaptiveStreamController({
      request: (layer) => this.requestLayer(track, layer, { automatic: true }),
      visibility: (visible) => this.setTrackHidden(track, !visible)
    });
    this.adaptiveControllers.set(key, controller);
    track.setLayerController({
      request: (layer, options) => this.requestLayer(track, layer, options ?? {}),
      observe: (element) => controller.observe(element),
      unobserve: (element) => controller.unobserve(element),
      setEnabled: (enabled) => this.setTrackEnabled(track, enabled),
      setVisible: (visible) => controller.setVisible(visible)
    });
  }
  /**
   * Asks the SFU for a particular layer of a subscribed track.
   *
   * Precedence, highest first:
   *
   * 1. **An explicit application request** (`automatic: false`). It pins
   *    the subscription: adaptive streaming will not move it afterwards.
   *    Requesting `auto` releases the pin.
   * 2. **Adaptive streaming** (`automatic: true`), when it is enabled and
   *    the track is not pinned. Driven by rendered element size.
   * 3. **The SFU's own choice** when neither has spoken: `auto`, which
   *    resolves to the best layer available.
   *
   * Whatever wins, it stays a preference. The SFU will not hand over a
   * layer the publisher is not sending, and congestion control may hold a
   * subscriber below what it asked for.
   *
   * `adaptiveStream` gates only rule 2. An explicit request works with
   * adaptive streaming off — that combination is exactly "I will manage
   * quality myself".
   *
   * Two pauses sit around those rules (§4, layer `off`).
   * `track.setEnabled(false)` beats all three. Adaptive streaming seeing
   * the track off screen beats only its own size choice — a pinned layer
   * is the application saying it wants this video, and is not second-
   * guessed. See {@link effectiveLayer}.
   */
  requestLayer(track, layer, options = {}) {
    const subscription = this.findSubscription(track);
    if (!subscription) return;
    const key = subscriptionKey(subscription.participantId, subscription.trackId);
    if (options.automatic) {
      if (!this.adaptiveStream) return;
      if (layer !== "auto") subscription.adaptiveLayer = layer;
    } else if (layer === "auto") {
      this.pinnedLayers.delete(key);
    } else {
      this.pinnedLayers.set(key, layer);
    }
    this.sendEffectiveLayer(subscription);
  }
  /**
   * The one layer a subscription should be on, from everything that has a
   * say. Highest precedence first:
   *
   * 1. `setEnabled(false)` → `off`.
   * 2. A pinned layer.
   * 3. Adaptive streaming: `off` while hidden, else the size-chosen layer.
   * 4. `auto`.
   */
  effectiveLayer(subscription) {
    const key = subscriptionKey(subscription.participantId, subscription.trackId);
    if (this.disabledTracks.has(key)) return "off";
    const pinned = this.pinnedLayers.get(key);
    if (pinned) return pinned;
    if (this.adaptiveStream) {
      if (subscription.hidden) return "off";
      if (subscription.adaptiveLayer) return subscription.adaptiveLayer;
    }
    return "auto";
  }
  /**
   * Sends the effective layer if the SFU does not already have it.
   *
   * A tile laid out repeatedly at the same size is the normal case, not
   * the exception. Every redundant message is a step towards the
   * connection's signaling rate limit and buys nothing. "Nothing sent yet"
   * means whatever the SFU starts a subscription on: `auto`, or `off` for
   * video under `autoSubscribe: false`.
   */
  sendEffectiveLayer(subscription) {
    if (trackKindToMediaKind(subscription.track.kind) === "audio") return;
    const key = subscriptionKey(subscription.participantId, subscription.trackId);
    const layer = this.effectiveLayer(subscription);
    const current = this.sentLayers.get(key) ?? (this.autoSubscribe ? "auto" : "off");
    if (current === layer) return;
    this.sentLayers.set(key, layer);
    this.signaling?.send({
      type: ClientMessageType.SUBSCRIPTION_UPDATE,
      publisherId: subscription.participantId,
      trackId: subscription.trackId,
      layer
    });
  }
  /** `RemoteTrack.setEnabled()`: an application pause that nothing automatic undoes. */
  setTrackEnabled(track, enabled) {
    const subscription = this.findSubscription(track);
    if (!subscription) return;
    const key = subscriptionKey(subscription.participantId, subscription.trackId);
    if (enabled) {
      this.disabledTracks.delete(key);
    } else {
      this.disabledTracks.add(key);
    }
    this.sendEffectiveLayer(subscription);
  }
  /** Adaptive streaming's visibility verdict, after its debounce. */
  setTrackHidden(track, hidden) {
    const subscription = this.findSubscription(track);
    if (!subscription || subscription.hidden === hidden) return;
    subscription.hidden = hidden;
    if (!this.adaptiveStream) return;
    this.sendEffectiveLayer(subscription);
  }
  /** The layer an application pinned for a subscribed track, if any. */
  pinnedLayer(track) {
    const subscription = this.findSubscription(track);
    if (!subscription) return void 0;
    return this.pinnedLayers.get(subscriptionKey(subscription.participantId, subscription.trackId));
  }
  findSubscription(track) {
    for (const subscription of this.subscribed.values()) {
      if (subscription.track === track) return subscription;
    }
    return void 0;
  }
  /** The simulcast state of a kind this participant publishes. */
  simulcastStatus(kind) {
    return this.published.get(kind)?.simulcast ?? "notApplicable";
  }
  // --- Data channel ------------------------------------------------------
  attachDataChannel(channel) {
    this.dataChannel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      this.logger.debug("data channel open");
      this.settleDataChannel();
      this.flushDataQueue();
    };
    channel.onmessage = (event) => this.handleIncomingData(event.data);
    channel.onclose = () => {
      if (this.dataChannel === channel) {
        this.dataChannel = void 0;
      }
    };
    if (channel.readyState === "open") {
      this.settleDataChannel();
      this.flushDataQueue();
    }
  }
  /**
   * Sends a payload, waiting for the channel if it is still coming up.
   *
   * A data channel needs its own `m=application` section, which means a
   * round trip before the first byte can go anywhere. That used to be the
   * caller's problem: `sendData()` created the channel, negotiated
   * nothing, and threw "The data channel is not open yet" — so the only
   * way to make data work was to publish a camera first and let its
   * renegotiation carry the channel along. Now the bootstrap happens here.
   */
  async sendData(payload, options = {}) {
    const topic = options.topic ?? "";
    const destinations = options.destinationIdentities ?? [];
    const askedLossy = options.reliable === false;
    let lossy = askedLossy;
    if (lossy && !this.supportsDataV2) {
      lossy = false;
      if (!this.lossyFallbackWarned) {
        this.lossyFallbackWarned = true;
        this.logger.warn("this server does not support lossy data (no data.v2); sending reliably instead");
      }
    }
    const limit = lossy ? MAX_LOSSY_PAYLOAD_BYTES : MAX_DATA_PAYLOAD_BYTES;
    if (payload.byteLength > limit) {
      throw new RTCError(
        "INVALID_ARGUMENT",
        `Data payload is ${payload.byteLength} bytes, over the ${limit}-byte ${lossy ? "lossy " : ""}limit`
      );
    }
    let bytes2 = payload;
    if (this.supportsDataV2 || topic.length > 0 || destinations.length > 0 || askedLossy) {
      try {
        bytes2 = encodeDataEnvelope(payload, { topic, destinationIdentities: destinations });
      } catch (error) {
        if (error instanceof DataEnvelopeError) {
          throw new RTCError("INVALID_ARGUMENT", error.message, error);
        }
        throw error;
      }
    }
    if (!this.pc && !this.signaling) {
      throw new RTCError("CONNECTION_FAILED", "sendData() requires an active connection");
    }
    if (lossy) {
      this.sendLossy(bytes2);
      return;
    }
    payload = bytes2;
    const channel = this.dataChannel ?? this.openDataChannel();
    if (!channel) {
      throw new RTCError("CONNECTION_FAILED", "sendData() requires an active connection");
    }
    if (channel.readyState === "open") {
      this.sendOnChannel(channel, payload);
      return;
    }
    this.dataQueue.push(payload);
    await this.dataChannelOpened();
    this.flushDataQueue();
  }
  /**
   * Opens the data channel for a participant that only wants to receive.
   *
   * The SFU fans data out over each recipient's own channel, so somebody
   * who never sends has nothing to receive on. `Room` calls this the
   * moment an application listens for `dataReceived`, which is the only
   * honest signal that a channel is wanted — opening one for every
   * participant at join would cost an SCTP association on every call that
   * never sends a byte.
   */
  ensureDataChannel() {
    this.dataChannelWanted = true;
    if (!this.dataChannel) {
      this.openDataChannel();
    }
    if (this.supportsDataV2 && !this.lossyChannel) {
      this.openLossyChannel();
    }
  }
  /**
   * Decodes one incoming message (phase7-contracts §1.3). Legacy bytes and
   * a malformed v2 frame alike come through untouched with no sender. The
   * sender identity is the SFU's, never the sender's own claim; `''` is
   * the server, reported as no participant.
   */
  handleIncomingData(data) {
    const bytes2 = toUint8Array(data);
    if (!bytes2) {
      return;
    }
    const decoded = decodeDataMessage(bytes2);
    if (decoded.legacy) {
      this.emit("dataReceived", bytes2, void 0, void 0);
      return;
    }
    const participant = decoded.senderIdentity ? this.remoteParticipants.get(decoded.senderIdentity) : void 0;
    this.emit("dataReceived", decoded.payload.slice(), participant, decoded.topic || void 0);
  }
  /** Fire-and-forget: lossy data is latest-wins, so nothing waits on it. */
  sendLossy(bytes2) {
    this.lossyChannelWanted = true;
    const channel = this.lossyChannel ?? this.openLossyChannel();
    if (!channel) {
      throw new RTCError("CONNECTION_FAILED", "sendData() requires an active connection");
    }
    if (channel.readyState === "open") {
      this.sendOnChannel(channel, bytes2);
      return;
    }
    this.lossyQueue.push(bytes2);
    if (this.lossyQueue.length > MAX_LOSSY_QUEUE) {
      this.lossyQueue.shift();
    }
  }
  openLossyChannel() {
    if (this.lossyChannel) {
      return this.lossyChannel;
    }
    const pc = this.pc ?? (this.signaling ? this.ensurePeerConnection() : void 0);
    if (!pc) {
      return void 0;
    }
    const channel = pc.createDataChannel(LOSSY_DATA_CHANNEL_LABEL, {
      ordered: false,
      maxRetransmits: 0,
      protocol: DATA_V2_PROTOCOL
    });
    this.attachLossyChannel(channel);
    return channel;
  }
  attachLossyChannel(channel) {
    this.lossyChannel = channel;
    channel.binaryType = "arraybuffer";
    const flush = () => {
      const queued = this.lossyQueue;
      this.lossyQueue = [];
      for (const bytes2 of queued) {
        try {
          this.sendOnChannel(channel, bytes2);
        } catch (error) {
          this.logger.debug("dropping a lossy data message", error.message);
        }
      }
    };
    channel.onopen = () => {
      this.logger.debug("lossy data channel open");
      flush();
    };
    channel.onmessage = (event) => this.handleIncomingData(event.data);
    channel.onclose = () => {
      if (this.lossyChannel === channel) {
        this.lossyChannel = void 0;
      }
    };
    if (channel.readyState === "open") {
      flush();
    }
  }
  /**
   * Creates the channel and asks for the renegotiation that carries it.
   *
   * Exactly once per connection: `dataChannel` is set synchronously here,
   * so two concurrent `sendData()` calls cannot both create one. A second
   * channel would be a second SCTP stream the SFU closes as unrecognised.
   *
   * The client creates it, not the server, because the client is the side
   * that knows it needs one. Ordered and reliable — the default, and what
   * anyone sending structured messages expects.
   */
  openDataChannel() {
    this.dataChannelWanted = true;
    const pc = this.pc ?? (this.signaling ? this.ensurePeerConnection() : void 0);
    if (!pc) {
      return void 0;
    }
    if (this.dataChannel) {
      return this.dataChannel;
    }
    const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true, protocol: DATA_V2_PROTOCOL });
    this.attachDataChannel(channel);
    return channel;
  }
  flushDataQueue() {
    const channel = this.dataChannel;
    if (!channel || channel.readyState !== "open" || this.dataQueue.length === 0) {
      return;
    }
    const queued = this.dataQueue;
    this.dataQueue = [];
    for (const payload of queued) {
      this.sendOnChannel(channel, payload);
    }
  }
  sendOnChannel(channel, payload) {
    try {
      channel.send(payload);
    } catch (error) {
      throw new RTCError("PERMISSION_DENIED", "Could not send data; check the token grants publishData", error);
    }
  }
  // --- Devices -----------------------------------------------------------
  async getDevices(kind) {
    return listDevices(kind);
  }
  async setDevice(kind, deviceId) {
    switch (kind) {
      case "videoinput":
        return this.replaceDevice("camera", () => createCameraTrack({ deviceId }));
      case "audioinput":
        return this.replaceDevice("microphone", () => createMicrophoneTrack({ deviceId }));
      case "audiooutput":
        return this.setAudioOutput(deviceId);
      default:
        throw new RTCError("DEVICE_NOT_FOUND", `Unknown device kind "${String(kind)}"`);
    }
  }
  /**
   * Swaps the device behind a published track without renegotiating.
   *
   * `replaceTrack` is what makes it seamless. Transceiver, SSRC, and every
   * subscriber's view of the track all stay put, so nobody else in the
   * room notices a thing.
   */
  async replaceDevice(kind, capture) {
    const entry = this.published.get(kind);
    if (!entry) {
      return;
    }
    const replacement = await capture();
    const previous = entry.track.mediaStreamTrack;
    await entry.delegate.replaceTrack(replacement.mediaStreamTrack);
    previous.stop();
  }
  /**
   * Points this room's remote audio at a different output device.
   *
   * `setSinkId` works per element, so this walks whatever elements each
   * remote audio track is attached to. Safari doesn't have `setSinkId` at
   * all. `Room.setSpeakerDevice()` checks and throws before we get here,
   * so an unsupported browser gets a real error instead of a silent no-op.
   */
  async setAudioOutput(deviceId) {
    const failures = [];
    for (const subscription of this.subscribed.values()) {
      if (trackKindToMediaKind(subscription.track.kind) === "video") {
        continue;
      }
      for (const element of subscription.track.detach()) {
        const withSink = element;
        try {
          await withSink.setSinkId?.(deviceId);
        } catch (error) {
          failures.push(error);
        }
        subscription.track.attach(element);
      }
    }
    if (failures.length > 0) {
      throw new RTCError("DEVICE_NOT_FOUND", "Could not switch the audio output device", failures[0]);
    }
  }
  // --- End-to-end encryption (phase5-contracts §3) -----------------------
  /** Builds this connection's E2EE controller from the configured key provider. */
  setupE2EE() {
    this.disposeE2EE();
    const options = this.e2eeOptions;
    if (!options) return;
    if (!isE2EESupported()) {
      this.logger.warn("this browser cannot encrypt media frames; end-to-end encryption is unavailable");
      return;
    }
    const factory = options.keyProvider;
    if (typeof factory.createController !== "function") {
      throw new RTCError(
        "E2EE_REQUIRED",
        "config.e2ee.keyProvider must come from createSharedKeyProvider() or createKeyProvider()"
      );
    }
    const controller = factory.createController({
      worker: options.worker,
      log: (message) => this.logger.warn(message)
    });
    controller.setStateListener(
      (participantId, direction, state) => this.handleE2EEState(participantId, direction, state)
    );
    this.e2ee = controller;
  }
  disposeE2EE() {
    this.e2ee?.dispose();
    this.e2ee = void 0;
    this.e2eeStates.clear();
  }
  /** On every join: whether the room requires E2EE, and the room id the passphrase is salted with. */
  applyRoomE2EE(roomId, joinedE2EE) {
    this.roomE2EE = this.roomE2EE || joinedE2EE;
    if (this.e2ee) {
      if (!this.roomE2EE) {
        this.logger.info("e2ee is configured but this room is not end-to-end encrypted; media is sent as usual");
      }
      void this.e2ee.start(this.e2eeRoomId || roomId, this.localParticipant.identity, this.roomE2EE).catch((error) => this.logger.error("could not load the e2ee keys", error.message));
    } else if (this.roomE2EE) {
      this.logger.warn(
        this.e2eeOptions ? "this room is end-to-end encrypted but this browser cannot encrypt; publishing is disabled" : "this room is end-to-end encrypted and no e2ee.keyProvider is configured; publishing is disabled"
      );
    }
  }
  /** The room requires E2EE. */
  get e2eeRequired() {
    return this.roomE2EE;
  }
  /** Whether this client is encrypting the media it sends (room requires it, and a controller exists). */
  get isE2EEActive() {
    return this.roomE2EE && this.e2ee !== void 0;
  }
  /**
   * An E2EE room never receives plaintext from this SDK: no key provider
   * means no publishing (§3.1).
   */
  assertMayPublishMedia() {
    if (!this.roomE2EE || this.e2ee) return;
    if (this.e2eeOptions) {
      throw new RTCError(
        "E2EE_NOT_SUPPORTED",
        "This room is end-to-end encrypted and this browser cannot encrypt media frames (no RTCRtpScriptTransform or encoded insertable streams)"
      );
    }
    throw new RTCError(
      "E2EE_REQUIRED",
      "This room is end-to-end encrypted: configure e2ee: { keyProvider } in createRTCClient() to publish into it"
    );
  }
  handleE2EEState(participantId, direction, state) {
    const participant = direction === "encrypt" ? this.localParticipant : this.remoteParticipants.get(participantId);
    if (!participant) return;
    const key = `${direction}:${participantId}`;
    if (this.e2eeStates.get(key) === state) return;
    this.e2eeStates.set(key, state);
    this.emit("e2eeStateChanged", participant, state);
  }
  // --- Teardown ----------------------------------------------------------
  async disconnect() {
    this.intentionalDisconnect = true;
    this._lastDisconnect = { reason: "CLIENT_INITIATED" };
    this.cancelMediaRejoin();
    for (const entry of this.published.values()) {
      entry.track.mediaStreamTrack.onended = null;
      entry.track.mediaStreamTrack.stop();
    }
    this.published.clear();
    this.localParticipant.tracks.length = 0;
    this.dataChannelWanted = false;
    this.dataQueue = [];
    this.lossyChannelWanted = false;
    this.lossyQueue = [];
    this.negotiationNeeded = false;
    this.abortDataChannelWaiters("The room was left before the data channel could open");
    this.signaling?.close();
    this.teardownPeerConnection();
    this.disposeE2EE();
    this.remoteParticipants.clear();
    this.pendingAgentStates.clear();
    this.subscribed.clear();
    this.announcedTracks.clear();
    this.pendingMedia.clear();
    this.layerActivity.clear();
    this.disabledTracks.clear();
    this.resetRoomSignals();
    this.setConnectionState("disconnected");
  }
  /**
   * Ends a session the server closed on purpose. Like `disconnect()`, minus
   * the leave message: the server already knows, and the socket is gone.
   */
  endSession(dataChannelReason) {
    this.intentionalDisconnect = true;
    this.cancelMediaRejoin();
    for (const entry of this.published.values()) {
      entry.track.mediaStreamTrack.onended = null;
      entry.track.mediaStreamTrack.stop();
    }
    this.published.clear();
    this.localParticipant.tracks.length = 0;
    this.dataChannelWanted = false;
    this.dataQueue = [];
    this.lossyChannelWanted = false;
    this.lossyQueue = [];
    this.negotiationNeeded = false;
    this.abortDataChannelWaiters(dataChannelReason);
    this.teardownPeerConnection();
    this.disposeE2EE();
    this.layerActivity.clear();
    this.resetRoomSignals();
    this.setConnectionState("disconnected");
  }
  /**
   * Throws the PeerConnection away along with everything that only meant
   * something on it: every subscription (its receiver and track are dead)
   * and every announcement (the rejoin's room state re-announces whatever
   * is still published). Local publications are desired state and survive;
   * `restoreLocalPublications()` puts them on the replacement.
   *
   * Subscribers get `trackUnsubscribed` now and `trackSubscribed` again
   * when the media comes back. Without this, a rebuilt connection's
   * arriving tracks matched a subscription that still existed for the dead
   * one and were silently dropped, so remote video froze on the last frame
   * for the rest of the call.
   */
  discardMediaConnection() {
    this.teardownPeerConnection();
    for (const [key, subscription] of this.subscribed) {
      this.subscribed.delete(key);
      this.adaptiveControllers.get(key)?.dispose();
      this.adaptiveControllers.delete(key);
      const participant = this.remoteParticipants.get(subscription.participantId);
      if (participant) {
        const index = participant.tracks.indexOf(subscription.track);
        if (index !== -1) {
          participant.tracks.splice(index, 1);
        }
        this.emit("trackUnsubscribed", subscription.track, participant);
      }
    }
    this.announcedTracks.clear();
    this.pendingMedia.clear();
    this.pendingSubscriptionStates.clear();
    this.negotiationScheduled = false;
    this.negotiationNeeded = false;
    this.iceRestartRequested = false;
  }
  /** Phase 6 §4.2. Unknown states and malformed frames are ignored, per the protocol rule. */
  applyAgentState(participantId, raw) {
    const state = parseAgentState(raw);
    if (typeof participantId !== "string" || !state) {
      return;
    }
    const target = participantId === this.localParticipant.identity ? this.localParticipant : this.remoteParticipants.get(participantId);
    if (!target) {
      if (state === "ended") {
        this.pendingAgentStates.delete(participantId);
      } else {
        this.pendingAgentStates.set(participantId, state);
      }
      return;
    }
    if (target._setAgentState(state)) {
      this.emit("agentStateChanged", target, state);
    }
  }
  applyPendingAgentState(participant) {
    const state = this.pendingAgentStates.get(participant.identity);
    if (state === void 0) {
      return;
    }
    this.pendingAgentStates.delete(participant.identity);
    if (participant._setAgentState(state)) {
      this.emit("agentStateChanged", participant, state);
    }
  }
  /** Drops a remote participant and their subscriptions, and says so. */
  removeRemoteParticipant(participant) {
    this.remoteParticipants.delete(participant.identity);
    this.e2ee?.participantLeft(participant.identity);
    this.e2eeStates.delete(`decrypt:${participant.identity}`);
    for (const [key, subscription] of this.subscribed) {
      if (subscription.participantId === participant.identity) {
        this.subscribed.delete(key);
        this.adaptiveControllers.get(key)?.dispose();
        this.adaptiveControllers.delete(key);
        this.emit("trackUnsubscribed", subscription.track, participant);
      }
    }
    for (const [key, announcement] of this.announcedTracks) {
      if (announcement.participantId === participant.identity) {
        this.announcedTracks.delete(key);
      }
    }
    if (this._activeSpeakers.includes(participant)) {
      participant._setSpeaking(false, 0);
      this._activeSpeakers = this._activeSpeakers.filter((speaker) => speaker !== participant);
      this.emit("activeSpeakersChanged", [...this._activeSpeakers]);
    }
    this.emit("participantLeft", participant);
  }
  /**
   * Rebuilds the media connection after ICE failed while signaling stayed
   * up. The first attempt goes at once — ICE has already spent its own
   * timeout deciding — and later ones back off, jittered.
   */
  scheduleMediaRejoin() {
    if (this.mediaRejoinTimer || this.intentionalDisconnect || !this.signaling) {
      return;
    }
    if (this.mediaRejoinAttempts >= MEDIA_REJOIN_MAX_ATTEMPTS) {
      this.logger.error(`media connection failed ${MEDIA_REJOIN_MAX_ATTEMPTS} times in a row; giving up`);
      this._lastDisconnect = {
        reason: "CONNECTION_FAILED",
        error: new RTCError(
          "CONNECTION_FAILED",
          `The media connection could not be re-established after ${MEDIA_REJOIN_MAX_ATTEMPTS} attempts`
        )
      };
      this.abortDataChannelWaiters("The connection failed before the data channel could open");
      this.signaling.close();
      this.teardownPeerConnection();
      this.setConnectionState("failed");
      return;
    }
    this.mediaRejoinAttempts++;
    const delay = this.mediaRejoinAttempts === 1 ? 0 : Math.random() * Math.min(MEDIA_REJOIN_BASE_MS * 2 ** (this.mediaRejoinAttempts - 2), MEDIA_REJOIN_MAX_MS);
    this.logger.warn(`media connection failed; rejoining (attempt ${this.mediaRejoinAttempts}) in ${Math.round(delay)}ms`);
    this.mediaRejoinTimer = setTimeout(() => {
      this.mediaRejoinTimer = void 0;
      if (this.intentionalDisconnect) {
        return;
      }
      this.awaitingResume = false;
      this.discardMediaConnection();
      this.signaling?.rejoin();
    }, delay);
  }
  cancelMediaRejoin() {
    if (this.mediaRejoinTimer) {
      clearTimeout(this.mediaRejoinTimer);
      this.mediaRejoinTimer = void 0;
    }
  }
  /**
   * The device's network changed (see `SFUAdapter.handleNetworkChange`).
   *
   * A reconnect waiting out its backoff runs now. Otherwise, with a live
   * media connection, ICE is restarted: the candidate pair it was using
   * belonged to the old network, and waiting for ICE to notice costs the
   * call several seconds of silence. Harmless on a connection that turns
   * out to have been fine — one extra offer/answer.
   */
  handleNetworkChange() {
    if (this.intentionalDisconnect || !this.signaling) {
      return;
    }
    if (this.signaling.isReconnecting) {
      this.logger.info("network changed; reconnecting now");
      this.signaling.reconnectNow();
      return;
    }
    const pc = this.pc;
    if (!pc || pc.connectionState === "closed") {
      return;
    }
    this.logger.info("network changed; restarting ICE");
    this.iceRestartRequested = true;
    this.negotiationNeeded = true;
    this.scheduleNegotiation();
  }
  /**
   * Applies a live permission change from the server (§1.4).
   *
   * Losing a publish right is not an error: the SFU has already
   * unpublished those tracks, so this stops the matching local
   * publications (releasing the device) and says so through
   * `localTrackUnpublished`, exactly as if the application had turned them
   * off. Gaining one needs nothing here: the next publish just works, on
   * the same connection.
   */
  applyPermissions(raw) {
    const permissions = {
      subscribe: raw.subscribe !== false,
      publish: raw.publish === true,
      publishAudio: raw.publishAudio === true,
      publishVideo: raw.publishVideo === true,
      publishData: raw.publishData === true
    };
    const updateOwnMetadata = typeof raw.updateOwnMetadata === "boolean" ? raw.updateOwnMetadata : this._permissions?.updateOwnMetadata;
    if (updateOwnMetadata !== void 0) {
      permissions.updateOwnMetadata = updateOwnMetadata;
    }
    this._permissions = permissions;
    this.logger.info("permissions updated by the server", JSON.stringify(permissions));
    const mayPublish = (mediaKind) => permissions.publish && (mediaKind === "audio" ? permissions.publishAudio : permissions.publishVideo);
    for (const [kind, entry] of [...this.published]) {
      if (mayPublish(entry.track.mediaStreamTrack.kind)) {
        continue;
      }
      this.logger.info("publish right withdrawn; stopping the local publication", kind);
      void this.withKindLock(kind, async () => {
        const current = this.published.get(kind);
        if (current) {
          await this.unpublish(current.track);
        }
      }).catch((error) => this.logger.debug("stopping a withdrawn publication failed", error.message));
    }
    this.emit("permissionsChanged", { ...permissions });
  }
  /**
   * The server muted one of our own tracks (§1.6). The SFU has stopped
   * forwarding it already; muting locally stops us spending bandwidth on
   * it and makes `track.isMuted` tell the truth.
   *
   * Unmuting stays the user's call. `enableMicrophone()` / `unmute()` work
   * as usual afterwards, and the server is told through the ordinary
   * `track.mute` message. A server *unmute* is not acted on: turning
   * somebody's microphone back on remotely is not something an SDK should
   * do behind its user's back.
   */
  async applyServerMute(trackId) {
    for (const entry of this.published.values()) {
      if (entry.trackId !== trackId && entry.track.mediaStreamTrack.id !== trackId) {
        continue;
      }
      if (!entry.track.isMuted) {
        await entry.track.mute();
      }
      this.logger.info("a local track was muted by the server", entry.track.kind);
      this.emit("localTrackMutedByServer", entry.track);
      return;
    }
    this.logger.debug("server muted a track we do not publish", trackId);
  }
  teardownPeerConnection() {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {
      }
      this.dataChannel = void 0;
    }
    if (this.lossyChannel) {
      try {
        this.lossyChannel.close();
      } catch {
      }
      this.lossyChannel = void 0;
    }
    if (!this.pc) {
      return;
    }
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ontrack = null;
    this.pc.ondatachannel = null;
    try {
      this.pc.close();
    } catch {
    }
    this.pc = void 0;
  }
  setConnectionState(state) {
    if (this._connectionState === state) {
      return;
    }
    this._connectionState = state;
    this.emit("connectionStateChanged", state);
  }
};
function msidTrackIdForMid(sdp, mid) {
  const sections = sdp.split(/\r?\nm=/).slice(1);
  for (const section of sections) {
    const lines = section.split(/\r?\n/);
    if (!lines.some((line) => line.trim() === `a=mid:${mid}`)) {
      continue;
    }
    const msid = lines.find((line) => line.startsWith("a=msid:"));
    const trackId = msid?.slice("a=msid:".length).trim().split(/\s+/)[1];
    return trackId && trackId.length > 0 ? trackId : void 0;
  }
  return void 0;
}
function subscriptionKey(participantId, trackId) {
  return `${participantId}/${trackId}`;
}
function pendingKey(trackId) {
  return `media:${trackId}`;
}
function declaredSourceFor(kind) {
  switch (kind) {
    case "camera":
    case "microphone":
    case "screenShare":
    case "screenShareAudio":
      return kind;
    default:
      return void 0;
  }
}
function toUint8Array(data) {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (isArrayBufferLike(data)) {
    return new Uint8Array(data);
  }
  return void 0;
}
function isArrayBufferLike(value) {
  const tag = Object.prototype.toString.call(value);
  return tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]";
}
function roomIdFromToken(token) {
  const claims = decodeClaims(token);
  const roomId = claims?.rid;
  if (typeof roomId !== "string" || roomId.length === 0) {
    throw new RTCError("INVALID_TOKEN", "RTC token does not name a room");
  }
  return roomId;
}
function permissionsFromToken(token) {
  const perms = decodeClaims(token)?.perms;
  if (!perms || typeof perms !== "object") {
    return void 0;
  }
  return {
    subscribe: perms.subscribe !== false,
    publish: perms.publish === true,
    publishAudio: perms.publishAudio === true,
    publishVideo: perms.publishVideo === true,
    publishData: perms.publishData === true,
    // Phase 7 §2. Only reported when the token says, so a token minted
    // before the grant existed reads exactly as it always did.
    ...typeof perms.updateOwnMetadata === "boolean" ? { updateOwnMetadata: perms.updateOwnMetadata } : {}
  };
}
function participantIdFromToken(token) {
  const claims = decodeClaims(token);
  return typeof claims?.sub === "string" ? claims.sub : "";
}
function decodeClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return void 0;
  }
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64));
  } catch {
    return void 0;
  }
}

// src/internal/telemetry/connection-id.ts
function generateConnectionId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `conn_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return `conn_${id}`;
}

// src/internal/telemetry/platform.ts
function detectPlatform() {
  if (typeof navigator === "undefined") {
    return { platform: "unknown", browser: "unknown" };
  }
  const ua = navigator.userAgent ?? "";
  let browser = "unknown";
  if (/edg\//i.test(ua)) browser = "edge";
  else if (/firefox|fxios/i.test(ua)) browser = "firefox";
  else if (/chrome|crios/i.test(ua)) browser = "chrome";
  else if (/safari/i.test(ua)) browser = "safari";
  let platform = "web";
  if (/android/i.test(ua)) platform = "android";
  else if (/iphone|ipad|ipod/i.test(ua)) platform = "ios";
  const connection = navigator.connection;
  const networkType = typeof connection?.effectiveType === "string" ? connection.effectiveType : void 0;
  return { platform, browser, networkType };
}

// src/internal/telemetry/telemetry-client.ts
function createTelemetryClient(options) {
  const connectionId = generateConnectionId();
  if (!options.enabled || !options.telemetryUrl) {
    return { connectionId, send: () => {
    } };
  }
  return new HttpTelemetryClient(connectionId, options);
}
var HttpTelemetryClient = class {
  constructor(connectionId, options) {
    this.connectionId = connectionId;
    this.options = options;
  }
  send(type, data = {}) {
    const body = {
      connectionId: this.connectionId,
      type,
      data: { sdkVersion: this.options.sdkVersion, ...detectPlatform(), ...data }
    };
    try {
      fetch(`${this.options.telemetryUrl}/v1/telemetry/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.options.token}` },
        body: JSON.stringify(body),
        keepalive: true
      }).then((res) => {
        if (!res.ok) {
          this.options.logger.debug("telemetry event rejected", type, res.status);
        }
      }).catch((error) => {
        this.options.logger.debug("telemetry event failed", type, error.message);
      });
    } catch (error) {
      this.options.logger.debug("telemetry send threw synchronously", type, error.message);
    }
  }
};

// src/version.ts
var SDK_VERSION = "0.1.0";

// src/room.ts
var _Room = class _Room extends TypedEventEmitter {
  /** @internal Use `client.join(roomId)`. The telemetry client defaults to a no-op, so tests and advanced setups can build a Room directly without wiring one up. */
  constructor(adapter, roomId, logger, telemetry = createTelemetryClient({ enabled: false, token: "", sdkVersion: SDK_VERSION, logger })) {
    super();
    this.reconnectCount = 0;
    this.adapter = adapter;
    this.roomId = roomId;
    this.logger = logger;
    this.telemetry = telemetry;
    this.connectionId = telemetry.connectionId;
    this.localParticipant = adapter.localParticipant;
    this.wireAdapterEvents();
  }
  get remoteParticipants() {
    return Array.from(this.adapter.remoteParticipants.values());
  }
  get connectionState() {
    return this.adapter.connectionState;
  }
  /**
   * Whether this room is end-to-end encrypted (created with `e2ee: true`).
   * In such a room publishing needs `RTCClientConfig.e2ee`; see
   * `isE2EEActive` for whether this client is actually encrypting.
   */
  get isE2EE() {
    return this.adapter.e2eeRequired === true;
  }
  /** True while this client encrypts what it sends (an E2EE room, with a key provider, on a capable browser). */
  get isE2EEActive() {
    return this.adapter.isE2EEActive === true;
  }
  /** Who is speaking right now, loudest first. See the `activeSpeakersChanged` event. */
  get activeSpeakers() {
    return this.adapter.activeSpeakers ?? [];
  }
  /**
   * What this participant may currently do: the token's grants, updated
   * live by the server. Undefined when the token carries no grants and the
   * server has not said. The server enforces these regardless; this is for
   * deciding which controls to show.
   */
  get permissions() {
    return this.adapter.permissions;
  }
  /**
   * Tells the SDK the device's network just changed — Wi-Fi to cellular,
   * a VPN coming up — so it can recover straight away instead of waiting
   * for timeouts: a pending reconnect runs now, and a live media
   * connection restarts ICE onto the new network.
   *
   * Browsers seldom give a page a reliable signal for this, so the web SDK
   * never calls it on its own; the React Native SDK calls it from NetInfo.
   * Safe to call at any time, and a no-op once the room has been left.
   */
  handleNetworkChange() {
    this.adapter.handleNetworkChange?.();
  }
  wireAdapterEvents() {
    let prevState = this.adapter.connectionState;
    this.adapter.on("connectionStateChanged", (state) => {
      this.emit("connectionStateChanged", state);
      if (state === "connected") {
        if (prevState === "reconnecting") {
          this.reconnectCount++;
          this.telemetry.send("reconnected");
          this.emit("reconnected");
        } else {
          this.telemetry.send("connected");
          this.emit("connected");
        }
        this.startStatsMonitor();
      } else if (state === "reconnecting" && prevState !== "reconnecting") {
        this.telemetry.send("reconnecting");
        this.emit("reconnecting");
      } else if (state === "disconnected" || state === "failed") {
        this.stopStatsMonitor();
        this.telemetry.send(state === "failed" ? "connection_failed" : "disconnected");
        const last = this.adapter.lastDisconnect;
        const reason = last?.reason ?? (state === "failed" ? "CONNECTION_FAILED" : "CLIENT_INITIATED");
        this.emit("disconnected", reason);
        if (state === "failed") {
          const error = last?.error ?? new RTCError("CONNECTION_FAILED", "Connection failed after exhausting reconnect attempts");
          this.telemetry.send("error", { code: error.code, message: error.message });
          this.emit("error", error);
        }
      }
      prevState = state;
    });
    this.adapter.on("participantJoined", (participant) => {
      this.telemetry.send("participant_joined", { participantIdentity: participant.identity });
      this.emit("participantJoined", participant);
    });
    this.adapter.on("participantLeft", (participant) => {
      this.telemetry.send("participant_left", { participantIdentity: participant.identity });
      this.emit("participantLeft", participant);
    });
    this.adapter.on("trackPublished", (kind, participant) => this.emit("trackPublished", kind, participant));
    this.adapter.on("trackUnpublished", (kind, participant) => this.emit("trackUnpublished", kind, participant));
    this.adapter.on("trackSubscribed", (track, participant) => this.emit("trackSubscribed", track, participant));
    this.adapter.on("trackUnsubscribed", (track, participant) => this.emit("trackUnsubscribed", track, participant));
    this.adapter.on("trackMuted", (kind, participant) => this.emit("trackMuted", kind, participant));
    this.adapter.on("trackUnmuted", (kind, participant) => this.emit("trackUnmuted", kind, participant));
    this.adapter.on("localTrackPublished", (track) => {
      this.telemetry.send("track_published", { kind: track.kind });
      this.emit("localTrackPublished", track);
    });
    this.adapter.on("localTrackUnpublished", (track) => {
      this.telemetry.send("track_unpublished", { kind: track.kind });
      this.emit("localTrackUnpublished", track);
    });
    this.adapter.on(
      "dataReceived",
      (payload, participant, topic) => this.emit("dataReceived", payload, participant, topic)
    );
    this.adapter.on("dataThrottled", (channel) => {
      this.logger.warn("data messages throttled", channel);
      this.emit("dataThrottled", channel);
    });
    this.adapter.on(
      "participantMetadataChanged",
      (participant, prev) => this.emit("participantMetadataChanged", participant, prev)
    );
    this.adapter.on("permissionsChanged", (permissions) => this.emit("permissionsChanged", permissions));
    this.adapter.on("localTrackMutedByServer", (track) => this.emit("localTrackMutedByServer", track));
    this.adapter.on("activeSpeakersChanged", (speakers) => this.emit("activeSpeakersChanged", speakers));
    this.adapter.on(
      "connectionQualityChanged",
      (participant, quality) => this.emit("connectionQualityChanged", participant, quality)
    );
    this.adapter.on("e2eeStateChanged", (participant, state) => this.emit("e2eeStateChanged", participant, state));
    this.adapter.on("transcriptionSegment", (segment) => this.emit("transcriptionSegment", segment));
    this.adapter.on("transcriptionStateChanged", (state) => this.emit("transcriptionStateChanged", state));
    this.adapter.on("agentStateChanged", (participant, state) => this.emit("agentStateChanged", participant, state));
    this.adapter.on(
      "trackSubscriptionStateChanged",
      (track, participant) => this.emit("trackSubscriptionStateChanged", track, participant)
    );
    this.adapter.on("warning", (warning) => {
      this.logger.warn("rtc warning", warning.code, warning.message);
      this.emit("warning", warning);
    });
    this.adapter.on("mediaError", (error) => {
      this.logger.warn("media device error", error.message);
      const rtcError = new RTCError("MEDIA_ERROR", error.message, error);
      this.telemetry.send("error", { code: rtcError.code, message: rtcError.message });
      this.emit("error", rtcError);
    });
  }
  /**
   * A non-secret diagnostic snapshot for support and debugging.
   *
   * Synchronous and cheap by design, so you can call it from anywhere at
   * any time, error handlers included. Live media stats are a separate
   * `async` call; see `getConnectionStats()`.
   */
  getDiagnostics() {
    const { platform, browser } = detectPlatform();
    const remote = this.adapter.getRemoteConnectionState?.() ?? {};
    return {
      connectionState: this.connectionState,
      iceConnectionState: this.adapter.getIceConnectionState?.(),
      signalingState: this.adapter.getSignalingState?.(),
      remoteIceConnectionState: remote.iceState,
      remotePeerConnectionState: remote.peerState,
      reconnectCount: this.reconnectCount,
      sdkVersion: SDK_VERSION,
      platform,
      browser
    };
  }
  /**
   * Live media-quality stats for every published and subscribed track.
   * RTT, jitter, packet loss, bitrate, codec, resolution/fps, and the
   * SFU's own connection-quality read. `ConnectionStats` explains why this
   * is kept apart from `getDiagnostics()`.
   *
   * Call it whenever you like, including before anything is published or
   * subscribed. You just get empty `local`/`remote` arrays then, not an
   * error.
   */
  async getConnectionStats() {
    const localTracks = this.localParticipant.tracks;
    const remoteTracks = this.remoteParticipants.flatMap((participant) => participant.tracks);
    const [local, remote] = await Promise.all([
      Promise.all(localTracks.map((track) => track.getStats())),
      Promise.all(remoteTracks.map((track) => track.getStats()))
    ]);
    return {
      connectionState: this.connectionState,
      connectionQuality: this.adapter.getConnectionQuality(),
      local: local.filter((stats) => stats !== void 0),
      remote: remote.filter((stats) => stats !== void 0)
    };
  }
  /**
   * Polls `getConnectionStats()` on a timer and ships the result as
   * telemetry, so the dashboard's RTC view (spec §23) has numbers to show
   * without every developer wiring it up by hand. Best-effort, same as
   * every other telemetry event here: failures get swallowed. A hiccup
   * collecting stats is no reason to disturb the call it's describing.
   */
  startStatsMonitor() {
    if (this.statsTimer) {
      return;
    }
    this.statsTimer = setInterval(() => {
      this.getConnectionStats().then((stats) => this.telemetry.send("stats", stats)).catch(() => {
      });
    }, _Room.STATS_INTERVAL_MS);
  }
  stopStatsMonitor() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = void 0;
    }
  }
  /** Captures and publishes the camera in one go. Resolves to the published track. */
  /**
   * Whether a kind you publish is genuinely sending a simulcast ladder.
   *
   * Read back from the negotiated sender, not from what was requested. A
   * browser that refuses the ladder publishes one full-quality layer and
   * reports `'unsupported'` here, having already logged a warning —
   * subscribers then cannot drop to a cheaper layer, which is what makes a
   * large call expensive for everyone in it.
   */
  simulcastStatus(kind) {
    return this.adapter.simulcastStatus?.(kind) ?? "notApplicable";
  }
  async enableCamera() {
    return this.adapter.enableCamera(true);
  }
  /** Stops publishing and releases the camera. */
  async disableCamera() {
    await this.adapter.enableCamera(false);
  }
  /** Captures and publishes the microphone in one call. Resolves to the published track. */
  async enableMicrophone() {
    return this.adapter.enableMicrophone(true);
  }
  /** Stops publishing and releases the microphone. */
  async disableMicrophone() {
    await this.adapter.enableMicrophone(false);
  }
  /**
   * Captures and publishes a screen share in one call. With
   * `{ audio: true }` the shared tab's or system's audio is published too,
   * as a `screenShareAudio` track, where the browser offers it (Chrome:
   * a tab, or the screen on Windows/ChromeOS). Resolves to the video track;
   * the audio one shows up in `localParticipant.tracks`. Disabling the
   * share, or the browser's own "Stop sharing", unpublishes both.
   */
  async enableScreenShare(options) {
    return options ? this.adapter.enableScreenShare(true, options) : this.adapter.enableScreenShare(true);
  }
  async disableScreenShare() {
    await this.adapter.enableScreenShare(false);
  }
  /**
   * Two events get special treatment here.
   *
   * **`dataReceived`** is what provisions this participant's data channel.
   * The SFU fans data out over each recipient's own channel, and a channel
   * is only created on demand — most calls never send a byte, and an SCTP
   * association for every participant regardless is a cost with nothing
   * behind it. So a page that never called `sendData()` could not
   * *receive* either, which made data one-way in exactly the setup people
   * try first. Subscribing to the event is the signal that one is wanted.
   *
   * **`trackSubscribed`** is replayed for tracks that were already
   * subscribed when the handler was added.
   *
   * Without that, joining a room where somebody is *already* publishing
   * never tells you about them. `client.join()` subscribes to the existing
   * publishers and emits during `connect()`, which is before the promise
   * resolves — so by the time a caller has a `Room` to call `.on()` on,
   * the events are gone. Media arrives and decodes; the application simply
   * never hears about it and renders nothing. That is the normal case for
   * a live stream, where every viewer joins a broadcast already in
   * progress, and the shape the documented example uses:
   *
   * ```ts
   * const room = await client.join(name);           // subscribes here
   * room.on('trackSubscribed', (t) => …);           // …handler added here
   * ```
   *
   * Only tracks a handler demonstrably missed are replayed — the ones
   * subscribed before it was added — so a handler registered up front
   * still sees each track exactly once, and adding a second handler later
   * cannot double-deliver to the first. Delivery is deferred to a
   * microtask so `.on()` stays a plain registration call and never
   * re-enters the caller before it has returned. `Promise.resolve()`
   * rather than `queueMicrotask`, so this holds on every engine the SDK
   * ships to, React Native's included.
   */
  on(event, handler) {
    if (event === "dataReceived") {
      this.adapter.ensureDataChannel?.();
    }
    if (event === "trackSubscribed") {
      const missed = this.remoteParticipants.flatMap(
        (participant) => participant.tracks.map((track) => ({ track, participant }))
      );
      if (missed.length > 0) {
        const subscribed = handler;
        void Promise.resolve().then(() => {
          for (const { track, participant } of missed) {
            subscribed(track, participant);
          }
        });
      }
    }
    return super.on(event, handler);
  }
  /**
   * Publishes a track you made with `client.createCameraTrack()` and
   * friends, or one you wrapped with `client.createCustomTrack()`.
   */
  async publish(track) {
    await this.adapter.publish(track);
  }
  async unpublish(track) {
    await this.adapter.unpublish(track);
  }
  /** Switches the active camera without republishing. */
  async setCameraDevice(deviceId) {
    await this.adapter.setDevice("videoinput", deviceId);
  }
  /** Switches the active microphone without republishing. */
  async setMicrophoneDevice(deviceId) {
    await this.adapter.setDevice("audioinput", deviceId);
  }
  /**
   * Switches the audio output ("speaker") device for this room's remote
   * audio elements. Phase 11 addition. Not supported everywhere: Safari
   * has no `HTMLMediaElement.setSinkId`. Browsers that don't implement it
   * get a `DEVICE_NOT_FOUND` throw instead of a silent no-op.
   */
  async setSpeakerDevice(deviceId) {
    if (typeof document !== "undefined") {
      const probe = document.createElement("audio");
      if (typeof probe.setSinkId !== "function") {
        throw new RTCError(
          "DEVICE_NOT_FOUND",
          "This browser doesn't support selecting an audio output device (no setSinkId)"
        );
      }
    }
    await this.adapter.setDevice("audiooutput", deviceId);
  }
  /**
   * Sends a small payload to everyone, or with `destinationIdentities` to
   * just those people. Requires the token's `publishData` grant; throws
   * PERMISSION_DENIED without it.
   *
   * Options (phase7-contracts §1.6): `topic` (≤255 bytes) labels the
   * message for recipients; `reliable: false` uses the lossy channel
   * (≤1,200 bytes, may drop, lowest latency). Without options this sends
   * exactly what it always has. Invalid options, and a payload over the
   * size limit (64 KiB reliable, 1,200 bytes lossy), throw INVALID_ARGUMENT.
   * Data messages are not end-to-end encrypted, even in an E2EE room.
   *
   * Works in an empty room with nothing published. The first call has to
   * negotiate a data channel — one round trip — which this awaits on your
   * behalf; payloads sent while the channel is still opening are queued
   * and go out in order. Rejects with CONNECTION_FAILED if the connection
   * dies before the channel can open, rather than hanging.
   */
  async sendData(payload, options) {
    const bytes2 = typeof payload === "string" ? new TextEncoder().encode(payload) : new Uint8Array(payload);
    if (options) {
      await this.adapter.sendData(bytes2, options);
    } else {
      await this.adapter.sendData(bytes2);
    }
  }
  /**
   * Resolves once the media connection is genuinely up.
   *
   * # Why this exists
   *
   * `client.join()` resolves when the **control plane** lets you in: room
   * joined, you know who else is here, you can publish. The media
   * connection finishes a moment later, once ICE and DTLS are done, which
   * means `connectionState` sits at `'connecting'` for a short window
   * after `join()` returns. That's the honest shape of an SFU connection,
   * and it's why `'connected'` is an event, not something joining
   * guarantees you.
   *
   * Most callers need none of this. `enableCamera()` and
   * `enableMicrophone()` work fine inside that window, and the `connected`
   * event is what you want driving a UI. This is for code that genuinely
   * has to block: a test, or a flow that mustn't move on until media is
   * live.
   *
   * Resolves straight away if already connected. Rejects on `'failed'` and
   * on timeout, rather than handing back a connection that isn't there.
   *
   * Careful: a subscriber joining a room where nobody is publishing can
   * quite legitimately stay `'connecting'`. With no tracks on either side
   * there's nothing to negotiate, so waiting here times out on a
   * connection that isn't broken at all. Where you can, drive the UI off
   * the `connected` event instead of blocking on this.
   */
  waitUntilConnected(timeoutMs = 15e3) {
    if (this.connectionState === "connected") {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const settle = (fn) => {
        clearTimeout(timer);
        this.off("connectionStateChanged", onState);
        fn();
      };
      const onState = (state) => {
        if (state === "connected") {
          settle(resolve);
        } else if (state === "failed") {
          settle(() => reject(new RTCError("CONNECTION_FAILED", "The connection failed while waiting for it")));
        }
      };
      const timer = setTimeout(() => {
        settle(
          () => reject(
            new RTCError(
              "CONNECTION_FAILED",
              `Still ${this.connectionState} after ${timeoutMs}ms; the media connection did not establish`
            )
          )
        );
      }, timeoutMs);
      this.on("connectionStateChanged", onState);
    });
  }
  /** Leaves the room, stops local tracks and closes the underlying connection. */
  async leave() {
    this.stopStatsMonitor();
    await this.adapter.disconnect();
  }
};
/**
 * How often the stats monitor samples and reports. Often enough that a
 * dashboard showing "now" isn't showing you five minutes ago, rarely
 * enough that it doesn't hammer the telemetry endpoint on a call where
 * dozens of participants are all doing exactly this.
 */
_Room.STATS_INTERVAL_MS = 5e3;
var Room = _Room;

// src/client.ts
var defaultAdapterFactory = (logger, autoReconnect, options) => new SwalvoAdapter(logger, autoReconnect, options);
var RTCClient = class {
  /**
   * @internal Use `createRTCClient(config)`. The second param exists purely
   * so tests can inject a fake SFUAdapter without a real browser and WebRTC
   * stack. Not part of the public config.
   */
  constructor(config, adapterFactory = defaultAdapterFactory) {
    this.config = config;
    this.logger = createLogger(config.logLevel);
    this.adapterFactory = adapterFactory;
  }
  /**
   * Joins the room this client's token was minted for.
   *
   * `roomId` is optional, because the token already names its room in the
   * `rnm`/`rid` claims — so `createRTCClient(grant)` then `join()` needs
   * nothing the mint response didn't already supply. Pass one explicitly
   * and it still has to match: a mismatch is `ROOM_NOT_FOUND` straight
   * away, before any connection is attempted.
   *
   * A token carrying neither claim (older tokens, hand-built test doubles)
   * has nothing to default to, and says so rather than connecting to a
   * room nobody named.
   */
  async join(roomId) {
    const target = roomId ?? roomFromToken(this.config.token);
    assertTokenMatchesRoom(this.config.token, target);
    this.logger.info("joining room", target);
    const telemetry = createTelemetryClient({
      enabled: this.config.telemetry,
      telemetryUrl: this.config.telemetryUrl,
      token: this.config.token,
      sdkVersion: SDK_VERSION,
      logger: this.logger
    });
    telemetry.send("connection_started");
    const adapter = this.adapterFactory(this.logger, this.config.autoReconnect, {
      adaptiveStream: this.config.adaptiveStream,
      preferredVideoCodec: this.config.preferredVideoCodec,
      audioRed: this.config.audioRed,
      e2ee: this.config.e2ee,
      refreshToken: this.config.refreshToken,
      autoSubscribe: this.config.autoSubscribe
    });
    const room = new Room(adapter, target, this.logger, telemetry);
    try {
      await adapter.connect(this.config.endpoint, this.config.token, this.config.iceServers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RTCError ? error.code : "CONNECTION_FAILED";
      telemetry.send("error", { code, message });
      telemetry.send("connection_failed");
      throw error;
    }
    this.currentRoom = room;
    return room;
  }
  /** Leaves the most recently joined room, if there is one. Same as `.leave()` on that `Room`. */
  async leave() {
    await this.currentRoom?.leave();
    this.currentRoom = void 0;
  }
  /** Captures a camera track without joining or publishing. Pair it with `room.publish(track)`. */
  async createCameraTrack(deviceId) {
    return createCameraTrack(deviceId ? { deviceId } : {});
  }
  /** Captures a microphone track without joining or publishing. Pair it with `room.publish(track)`. */
  async createMicrophoneTrack(deviceId) {
    return createMicrophoneTrack(deviceId ? { deviceId } : {});
  }
  /** Captures a screen-share track without joining or publishing. Pair it with `room.publish(track)`. */
  async createScreenShareTrack() {
    return createScreenShareTrack();
  }
  /**
   * Wraps a `MediaStreamTrack` your application produced — a
   * `canvas.captureStream()` frame source, a Web Audio graph, a decoded
   * file, a virtual camera — so it can be published like any other track.
   *
   * Synchronous, because there is nothing to capture: you already have the
   * track. `source` decides how the SFU labels it for everyone else, and
   * defaults to `camera` for video and `microphone` for audio.
   *
   * ```ts
   * const canvasTrack = canvas.captureStream(30).getVideoTracks()[0];
   * await room.publish(client.createCustomTrack(canvasTrack, { source: 'camera' }));
   * ```
   *
   * Swalvo never captured this track, so stopping the underlying source is
   * yours to do; `room.unpublish(track)` stops the track itself, as it
   * does for every other kind.
   */
  createCustomTrack(mediaStreamTrack, options = {}) {
    return createCustomTrack(mediaStreamTrack, options);
  }
  /** Lists available devices. Labels only fill in once permission has been granted at least once. */
  async getDevices(kind) {
    return listDevices(kind);
  }
  /**
   * Subscribes to devices coming and going (Phase 11 addition), like a USB
   * webcam being plugged in or yanked out. Returns an unsubscribe function.
   *
   * In an environment with no `navigator.mediaDevices` this is a no-op with
   * an immediately-callable unsubscribe, rather than a throw. It's an
   * optional convenience, not a capability anything depends on.
   */
  onDeviceChange(callback) {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      return () => {
      };
    }
    navigator.mediaDevices.addEventListener("devicechange", callback);
    return () => navigator.mediaDevices.removeEventListener("devicechange", callback);
  }
  /** Switches the active camera on the currently joined room. */
  async setCamera(deviceId) {
    if (!this.currentRoom) {
      throw new RTCError("CONNECTION_FAILED", "setCamera() requires an active room; call join() first");
    }
    await this.currentRoom.setCameraDevice(deviceId);
  }
  /** Switches the active microphone on the currently joined room. */
  async setMicrophone(deviceId) {
    if (!this.currentRoom) {
      throw new RTCError("CONNECTION_FAILED", "setMicrophone() requires an active room; call join() first");
    }
    await this.currentRoom.setMicrophoneDevice(deviceId);
  }
  /** Diagnostic snapshot of the currently joined room. See `Room.getDiagnostics()`. */
  getDiagnostics() {
    if (!this.currentRoom) {
      throw new RTCError("CONNECTION_FAILED", "getDiagnostics() requires an active room; call join() first");
    }
    return this.currentRoom.getDiagnostics();
  }
};
function roomFromToken(token) {
  const { roomName, roomId } = decodeTokenPayload(token);
  const room = roomName ?? roomId;
  if (!room) {
    throw new RTCError(
      "ROOM_NOT_FOUND",
      'join() with no argument needs the room from the token, but this token carries neither an "rnm" nor an "rid" claim. Pass the room explicitly: join(roomName).'
    );
  }
  return room;
}
function createRTCClient(config) {
  const resolved = validateConfig(config);
  return new RTCClient(resolved);
}

// src/e2ee/crypto.ts
var E2EE_PASSPHRASE_SALT_PREFIX = "LivqenoE2EE:";
var E2EE_RATCHET_SALT = "LivqenoRatchet";
var E2EE_PBKDF2_ITERATIONS = 1e5;
var E2EE_DEFAULT_RATCHET_WINDOW = 8;
var HKDF_INFO = new Uint8Array(128);
function subtle() {
  const value = globalThis.crypto?.subtle;
  if (!value) {
    throw new Error("WebCrypto (crypto.subtle) is unavailable; end-to-end encryption needs a secure context");
  }
  return value;
}
var encoder2 = new TextEncoder();
function bytes(view) {
  const source = view instanceof Uint8Array ? view : new Uint8Array(view);
  const out = new Uint8Array(new ArrayBuffer(source.byteLength));
  out.set(source);
  return out;
}
async function deriveMaterialFromPassphrase(passphrase, roomId) {
  const base = await subtle().importKey("raw", bytes(encoder2.encode(passphrase)), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    {
      name: "PBKDF2",
      salt: bytes(encoder2.encode(E2EE_PASSPHRASE_SALT_PREFIX + roomId)),
      iterations: E2EE_PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    base,
    256
  );
  return new Uint8Array(bits);
}
async function hkdf(material, lengthBits) {
  const base = await subtle().importKey("raw", bytes(material), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: bytes(encoder2.encode(E2EE_RATCHET_SALT)), info: HKDF_INFO },
    base,
    lengthBits
  );
  return new Uint8Array(bits);
}
function ratchetMaterial(material) {
  return hkdf(material, 256);
}

// inline-worker:/Users/enfecatulsingh/Desktop/untitled folder/ideas/webrtrc/packages/sdk/src/e2ee/worker.ts
var worker_default = '"use strict";(()=>{var F="LivqenoRatchet";var L=new Uint8Array(128);function E(){let t=globalThis.crypto?.subtle;if(!t)throw new Error("WebCrypto (crypto.subtle) is unavailable; end-to-end encryption needs a secure context");return t}var M=new TextEncoder;function p(t){let e=t instanceof Uint8Array?t:new Uint8Array(t),r=new Uint8Array(new ArrayBuffer(e.byteLength));return r.set(e),r}async function I(t,e){let r=await E().importKey("raw",p(t),"HKDF",!1,["deriveBits"]),i=await E().deriveBits({name:"HKDF",hash:"SHA-256",salt:p(M.encode(F)),info:L},r,e);return new Uint8Array(i)}function R(t){return I(t,128)}function g(t){return I(t,256)}async function l(t){let e=await R(t),r=await E().importKey("raw",p(e),{name:"AES-GCM"},!1,["encrypt","decrypt"]);return{material:p(t),key:r}}function K(t){let e=[],r=0;for(;r+3<=t.length;)t[r]===0&&t[r+1]===0&&t[r+2]===1?(e.push(r+3),r+=3):r+=1;return e}var P=1,H=5;function N(t){for(let e of K(t)){if(e>=t.length)continue;let r=t[e]&31;if(r===P||r===H)return Math.min(e+2,t.length)}return 0}function x(t,e,r){switch(t){case"opus":return Math.min(1,e.length);case"vp8":return Math.min(r?10:3,e.length);case"h264":return N(e);default:return 0}}function W(t){for(let e=0;e+3<t.length;e++)if(t[e]===0&&t[e+1]===0&&t[e+2]===3)return!0;return!1}function D(t){let e=[];for(let r=0;r<t.length;)t.length-r>=3&&t[r]===0&&t[r+1]===0&&t[r+2]===3?(e.push(0,0),r+=3):(e.push(t[r]),r+=1);return new Uint8Array(e)}function G(t){let e=[],r=0;for(let i of t)i<=3&&r>=2&&(e.push(3),r=0),e.push(i),r=i===0?r+1:0;return new Uint8Array(e)}function w(t,e,r){let i=new Uint8Array(12),n=new DataView(i.buffer);return n.setUint32(0,t>>>0),n.setUint32(4,e>>>0),n.setUint32(8,e-r%65535>>>0),i}async function U(t,e,r,i,n){let a=x(e.codec,t,e.isKeyFrame),o=t.subarray(0,a),s=new Uint8Array(await E().encrypt({name:"AES-GCM",iv:p(n),additionalData:p(o),tagLength:128},r.key,p(t.subarray(a)))),c=new Uint8Array(s.length+n.length+2);c.set(s,0),c.set(n,s.length),c[s.length+n.length]=n.length,c[s.length+n.length+1]=i&255,e.codec==="h264"&&(c=G(c));let y=new Uint8Array(a+c.length);return y.set(o,0),y.set(c,a),y}function k(t,e){if(t.length<2)return;let r=t[t.length-2],i=t[t.length-1];if(r!==12)return;let n=x(e.codec,t,e.isKeyFrame);if(t.length<n+r+2+16)return;let a=t.subarray(0,n),o=t.slice(t.length-2-r,t.length-2),s=t.subarray(n);e.codec==="h264"&&W(s)&&(s=D(s));let c=s.length-r-2;if(!(c<16))return{header:a,iv:o,keyIndex:i,payload:s.subarray(0,c)}}async function b(t,e){let r=new Uint8Array(await E().decrypt({name:"AES-GCM",iv:p(t.iv),additionalData:p(t.header),tagLength:128},e.key,p(t.payload))),i=new Uint8Array(t.header.length+r.length);return i.set(t.header,0),i.set(r,t.header.length),i}var O="\\0shared",m=class{constructor(e){this.options=e;this.enabled=!0;this.rings=new Map;this.currentIndex=new Map;this.sendCounts=new Map;this.lastState=new Map;this.ratchetWindow=e.ratchetWindow??8}ringId(e){return this.options.sharedKey||e===void 0?O:e}async setKey(e,r,i=0){let n=await l(r),a=this.ringId(e),o=this.rings.get(a);o||(o=new Map,this.rings.set(a,o)),o.set(i&255,n),this.currentIndex.set(a,i&255)}async ratchet(e,r){let i=this.ringId(e),n=r??this.currentIndex.get(i)??0,a=this.rings.get(i)?.get(n);if(!a)return;let o=await g(a.material);return this.rings.get(i)?.set(n,await l(o)),o}hasKey(e,r){let i=this.ringId(e);return this.rings.get(i)?.has(r??this.currentIndex.get(i)??0)??!1}report(e,r,i){let n=`${r}\\0${e}`;this.lastState.get(n)!==i&&(this.lastState.set(n,i),this.options.onStateChanged?.(e,r,i))}forget(e){this.lastState.delete(`encrypt\\0${e}`),this.lastState.delete(`decrypt\\0${e}`)}async encrypt(e,r,i,n,a){if(!this.enabled||r.length===0)return r;let o=this.ringId(e),s=this.currentIndex.get(o)??0,c=this.rings.get(o)?.get(s);if(!c)return this.report(e,"encrypt","missing_key"),null;let y=this.sendCounts.get(n);y===void 0&&(y=Math.floor(Math.random()*65535)),this.sendCounts.set(n,y+1);try{let d=await U(r,i,c,s,w(n,a,y));return this.report(e,"encrypt","ok"),d}catch{return this.report(e,"encrypt","encrypt_failed"),null}}async decrypt(e,r,i){if(!this.enabled||r.length===0)return r;let n=k(r,i);if(!n)return this.report(e,"decrypt","decrypt_failed"),null;let a=this.ringId(e),o=this.rings.get(a)?.get(n.keyIndex);if(!o)return this.report(e,"decrypt","missing_key"),null;try{let c=await b(n,o);return this.report(e,"decrypt","ok"),c}catch{}let s=o.material;for(let c=0;c<this.ratchetWindow;c++){s=await g(s);let y=await l(s);try{let d=await b(n,y);return this.rings.get(a)?.set(n.keyIndex,y),this.options.onKeyRatcheted?.(this.options.sharedKey?void 0:e,n.keyIndex,s),this.report(e,"decrypt","ok"),d}catch{}}return this.report(e,"decrypt","decrypt_failed"),null}};function _(t){switch(t?.toLowerCase().split("/")[1]){case"vp8":return"vp8";case"vp9":return"vp9";case"av1":case"av1x":return"av1";case"h264":return"h264";case"opus":return"opus";default:return}}var T=self,f,A="",S=new Map,v={encrypt:{},decrypt:{}};function u(t){T.postMessage(t)}function h(t=!0,e){return f||(f=new m({sharedKey:t,ratchetWindow:e,onStateChanged:(r,i,n)=>u({type:"state",participantId:r,direction:i,state:n}),onKeyRatcheted:(r,i,n)=>u({type:"ratcheted",participantId:r,keyIndex:i,material:n})})),f}function q(t){return t.length>4&&t[0]===0&&t[1]===0&&(t[2]===1||t[2]===0&&t[3]===1)}function $(t,e,r){if(e.kind==="audio")return"opus";let i={};try{i=t.getMetadata()}catch{}return _(i.mimeType)??(i.payloadType!==void 0?v[e.direction][i.payloadType]:void 0)??e.codec??(q(r)?"h264":"vp8")}function C(t,e,r){let i=new TransformStream({async transform(n,a){let o=f;if(!o){r.direction==="decrypt"&&a.enqueue(n);return}if(!o.enabled){a.enqueue(n);return}let s=new Uint8Array(n.data),c={codec:$(n,r,s),isKeyFrame:n.type==="key"},y;if(r.direction==="encrypt"){let d=n.getMetadata().synchronizationSource??0;y=await o.encrypt(A,s,c,d,n.timestamp)}else{let d=S.get(r.transformId)??r.participantId;if(!d)return;y=await o.decrypt(d,s,c)}y&&(y!==s&&(n.data=y.buffer.slice(y.byteOffset,y.byteOffset+y.byteLength)),a.enqueue(n))}});t.pipeThrough(i).pipeTo(e).catch(n=>u({type:"error",message:String(n?.message??n)}))}T.onmessage=t=>{let e=t.data;switch(e.type){case"init":A=e.localParticipantId,h(e.sharedKey,e.ratchetWindow).enabled=e.enabled;break;case"setKey":h().setKey(e.participantId,e.material,e.keyIndex).catch(r=>u({type:"error",message:r.message}));break;case"ratchet":h().ratchet(e.participantId,e.keyIndex).then(r=>{r&&u({type:"ratcheted",participantId:e.participantId,keyIndex:e.keyIndex??-1,material:r,requestId:e.requestId})}).catch(r=>u({type:"error",message:r.message}));break;case"enable":h().enabled=e.enabled;break;case"setLocalParticipant":A=e.participantId;break;case"setTransformParticipant":S.set(e.transformId,e.participantId);break;case"payloadTypes":v[e.direction]=e.map;break;case"forget":f?.forget(e.participantId);break;case"transform":{let{readable:r,writable:i,type:n,...a}=e;C(r,i,a);break}default:break}};T.onrtctransform=t=>{let{readable:e,writable:r,options:i}=t.transformer;C(e,r,i)};})();\n';

// src/e2ee/worker-protocol.ts
function codecFromMimeType(mimeType) {
  switch (mimeType?.toLowerCase().split("/")[1]) {
    case "vp8":
      return "vp8";
    case "vp9":
      return "vp9";
    case "av1":
    case "av1x":
      return "av1";
    case "h264":
      return "h264";
    case "opus":
      return "opus";
    default:
      return void 0;
  }
}
function payloadTypesFromSdp(sdp) {
  const map = {};
  for (const line of sdp.split(/\r?\n/)) {
    const match = /^a=rtpmap:(\d+) ([^/\s]+)\//.exec(line);
    if (!match) continue;
    const codec = codecFromMimeType(`x/${match[2]}`);
    if (codec) map[Number(match[1])] = codec;
  }
  return map;
}

// src/e2ee/manager.ts
var transformCounter = 0;
var E2EEManager = class {
  constructor(host, options) {
    this.host = host;
    this.needsInsertableStreams = !hasScriptTransform();
    this.transformed = /* @__PURE__ */ new WeakSet();
    this.receiverIds = /* @__PURE__ */ new WeakMap();
    this.pendingRatchets = /* @__PURE__ */ new Map();
    this.requestId = 0;
    this.started = false;
    if (options.worker) {
      this.worker = options.worker;
      this.ownsWorker = false;
    } else {
      const url = URL.createObjectURL(new Blob([worker_default], { type: "text/javascript" }));
      this.worker = new Worker(url, { name: "livqeno-e2ee" });
      URL.revokeObjectURL(url);
      this.ownsWorker = true;
    }
    this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
    this.worker.onerror = (event) => options.log?.(`e2ee worker error: ${event.message ?? event}`);
    host.register(this);
  }
  post(message, transfer = []) {
    this.worker.postMessage(message, transfer);
  }
  handleWorkerMessage(message) {
    switch (message.type) {
      case "state":
        this.listener?.(message.participantId, message.direction, message.state);
        break;
      case "ratcheted":
        if (message.requestId !== void 0) {
          this.pendingRatchets.get(message.requestId)?.(message.material);
          this.pendingRatchets.delete(message.requestId);
        } else {
          this.host.onWorkerRatcheted(message.participantId, message.keyIndex, message.material);
        }
        break;
    }
  }
  setStateListener(listener) {
    this.listener = listener;
  }
  async start(roomId, localParticipantId, enabled) {
    this.post({
      type: "init",
      sharedKey: this.host.sharedKey,
      ratchetWindow: this.host.ratchetWindow,
      localParticipantId,
      enabled
    });
    if (!this.started) {
      this.started = true;
      for (const key of await this.host.currentKeys(roomId)) {
        this.pushKey(key.participantId, key.material, key.keyIndex);
      }
    }
  }
  /** Called by the provider whenever the app sets a key. */
  pushKey(participantId, material, keyIndex) {
    this.post({ type: "setKey", participantId, material, keyIndex });
  }
  /** Ratchets inside the worker (where the live key ring is). */
  ratchet(participantId, keyIndex) {
    const requestId = ++this.requestId;
    return new Promise((resolve) => {
      this.pendingRatchets.set(requestId, resolve);
      this.post({ type: "ratchet", requestId, participantId, keyIndex });
    });
  }
  attach(target, options) {
    if (this.transformed.has(target)) return;
    this.transformed.add(target);
    if (hasScriptTransform()) {
      target.transform = new RTCRtpScriptTransform(this.worker, options);
      return;
    }
    const streams = target.createEncodedStreams();
    this.post({ type: "transform", ...options, readable: streams.readable, writable: streams.writable }, [
      streams.readable,
      streams.writable
    ]);
  }
  setupSender(sender, kind) {
    this.attach(sender, { transformId: `s${++transformCounter}`, direction: "encrypt", kind });
  }
  setupReceiver(receiver, kind, participantId) {
    const known = this.receiverIds.get(receiver);
    if (known) {
      if (participantId) this.post({ type: "setTransformParticipant", transformId: known, participantId });
      return;
    }
    const transformId = `r${++transformCounter}`;
    this.receiverIds.set(receiver, transformId);
    this.attach(receiver, { transformId, direction: "decrypt", kind, participantId });
    if (participantId) this.post({ type: "setTransformParticipant", transformId, participantId });
  }
  updatePayloadTypes(localSdp, remoteSdp) {
    if (localSdp) this.post({ type: "payloadTypes", direction: "encrypt", map: payloadTypesFromSdp(localSdp) });
    if (remoteSdp) this.post({ type: "payloadTypes", direction: "decrypt", map: payloadTypesFromSdp(remoteSdp) });
  }
  participantLeft(participantId) {
    this.post({ type: "forget", participantId });
  }
  dispose() {
    this.host.unregister(this);
    for (const resolve of this.pendingRatchets.values()) resolve(void 0);
    this.pendingRatchets.clear();
    this.worker.onmessage = null;
    if (this.ownsWorker) this.worker.terminate();
  }
};

// src/e2ee/key-provider.ts
function toBytes(key) {
  if (typeof key === "string") return new TextEncoder().encode(key);
  return key instanceof Uint8Array ? new Uint8Array(key) : new Uint8Array(key);
}
function checkIndex(keyIndex) {
  if (!Number.isInteger(keyIndex) || keyIndex < 0 || keyIndex > 255) {
    throw new RTCError("INVALID_TOKEN", "E2EE keyIndex must be an integer from 0 to 255");
  }
  return keyIndex;
}
var KeyProvider = class {
  /** @internal Use `createSharedKeyProvider()` or `createKeyProvider()`. */
  constructor(options) {
    /** Explicit keys (per-participant mode, or a shared key set as bytes). `undefined` participant = shared. */
    this.keys = /* @__PURE__ */ new Map();
    this.currentIndex = /* @__PURE__ */ new Map();
    this.passphraseMaterial = /* @__PURE__ */ new Map();
    this.managers = /* @__PURE__ */ new Set();
    this.sharedKey = options.sharedKey;
    this.passphrase = options.passphrase;
    this.ratchetWindow = options.ratchetWindow ?? E2EE_DEFAULT_RATCHET_WINDOW;
  }
  /**
   * Sets the key for `participantId` at `keyIndex`, and makes that index
   * the one they encrypt with (for your own id: the one you encrypt with).
   * `key` is raw key material — at least 16 random bytes; a string is
   * taken as its UTF-8 bytes. In shared mode the participant id is ignored
   * and the key replaces the passphrase-derived one for everyone.
   */
  async setKey(participantId, key, keyIndex = 0) {
    checkIndex(keyIndex);
    const id = this.sharedKey ? void 0 : participantId;
    const material = toBytes(key);
    let ring = this.keys.get(id);
    if (!ring) {
      ring = /* @__PURE__ */ new Map();
      this.keys.set(id, ring);
    }
    ring.set(keyIndex, material);
    this.currentIndex.set(id, keyIndex);
    for (const manager of this.managers) manager.pushKey(id, material, keyIndex);
  }
  /**
   * Advances a key one ratchet step (HKDF-SHA256, salt `LivqenoRatchet`).
   * Ratchet your own key after someone leaves so they cannot decrypt what
   * follows; receivers follow automatically within `ratchetWindow` steps.
   * In shared mode the participant id is ignored.
   */
  async ratchetKey(participantId, keyIndex) {
    const id = this.sharedKey ? void 0 : participantId;
    const index = keyIndex ?? this.currentIndex.get(id) ?? 0;
    checkIndex(index);
    if (this.managers.size > 0) {
      let material;
      for (const manager of this.managers) {
        material = await manager.ratchet(id, index) ?? material;
      }
      if (material) this.store(id, index, material);
      return;
    }
    const current = await this.materialFor(id, index);
    if (!current) {
      throw new RTCError("E2EE_REQUIRED", "There is no key to ratchet for this participant yet");
    }
    this.store(id, index, await ratchetMaterial(current));
  }
  store(id, keyIndex, material) {
    let ring = this.keys.get(id);
    if (!ring) {
      ring = /* @__PURE__ */ new Map();
      this.keys.set(id, ring);
    }
    ring.set(keyIndex, material);
  }
  async materialFor(id, keyIndex) {
    const explicit = this.keys.get(id)?.get(keyIndex);
    if (explicit) return explicit;
    return void 0;
  }
  /** @internal */
  async currentKeys(roomId) {
    const out = [];
    if (this.passphrase !== void 0 && !this.keys.get(void 0)?.has(0)) {
      let pending = this.passphraseMaterial.get(roomId);
      if (!pending) {
        pending = deriveMaterialFromPassphrase(this.passphrase, roomId);
        this.passphraseMaterial.set(roomId, pending);
      }
      out.push({ participantId: void 0, material: await pending, keyIndex: 0 });
    }
    for (const [participantId, ring] of this.keys) {
      const current = this.currentIndex.get(participantId);
      for (const [keyIndex, material] of ring) {
        if (keyIndex !== current) out.push({ participantId, material, keyIndex });
      }
      if (current !== void 0 && ring.has(current)) {
        out.push({ participantId, material: ring.get(current), keyIndex: current });
      }
    }
    return out;
  }
  /** @internal */
  register(manager) {
    this.managers.add(manager);
  }
  /** @internal */
  unregister(manager) {
    this.managers.delete(manager);
  }
  /** @internal */
  onWorkerRatcheted(participantId, keyIndex, material) {
    this.store(participantId, keyIndex, material);
  }
  /** @internal Called by the RTC adapter for each connection. */
  createController(options) {
    return new E2EEManager(this, options);
  }
};
function createSharedKeyProvider(passphrase, options = {}) {
  if (typeof passphrase !== "string" || passphrase.length === 0) {
    throw new RTCError("E2EE_REQUIRED", "createSharedKeyProvider(passphrase) needs a non-empty passphrase");
  }
  return new KeyProvider({ ...options, sharedKey: true, passphrase });
}
function createKeyProvider(options = {}) {
  return new KeyProvider({ ...options, sharedKey: false });
}

// src/internal/preflight/stats.ts
function entriesOf(report) {
  const entries = [];
  report.forEach((value) => {
    if (value && typeof value === "object") entries.push(value);
  });
  return entries;
}
var num = (value) => typeof value === "number" && Number.isFinite(value) ? value : void 0;
function selectedPair(entries) {
  const byId = new Map(entries.filter((entry) => typeof entry.id === "string").map((entry) => [entry.id, entry]));
  for (const entry of entries) {
    if (entry.type === "transport" && typeof entry.selectedCandidatePairId === "string") {
      const pair = byId.get(entry.selectedCandidatePairId);
      if (pair) return pair;
    }
  }
  return entries.find(
    (entry) => entry.type === "candidate-pair" && entry.state === "succeeded" && (entry.nominated === true || entry.selected === true)
  );
}
function routeFromReport(report) {
  const entries = entriesOf(report);
  const pair = selectedPair(entries);
  if (!pair) return {};
  const local = entries.find((entry) => entry.id === pair.localCandidateId);
  if (!local) return {};
  const type = local.candidateType;
  const candidateType = type === "host" || type === "srflx" || type === "prflx" || type === "relay" ? type : void 0;
  const protocol = local.protocol === "udp" || local.protocol === "tcp" ? local.protocol : void 0;
  const relay = local.relayProtocol;
  const relayProtocol = relay === "udp" || relay === "tcp" || relay === "tls" ? relay : void 0;
  return {
    candidateType,
    usedRelay: candidateType === void 0 ? void 0 : candidateType === "relay",
    protocol,
    relayProtocol: candidateType === "relay" ? relayProtocol : void 0
  };
}
function sampleFromReport(report, at) {
  const entries = entriesOf(report);
  const pair = selectedPair(entries);
  const rtt = num(pair?.currentRoundTripTime);
  let bytesSent;
  let packetsSent;
  for (const entry of entries) {
    if (entry.type !== "outbound-rtp") continue;
    const bytes2 = num(entry.bytesSent);
    const packets = num(entry.packetsSent);
    if (bytes2 !== void 0) bytesSent = (bytesSent ?? 0) + bytes2;
    if (packets !== void 0) packetsSent = (packetsSent ?? 0) + packets;
  }
  let jitter;
  let packetsLost;
  for (const entry of entries) {
    if (entry.type !== "remote-inbound-rtp") continue;
    const j = num(entry.jitter);
    if (j !== void 0) jitter = Math.max(jitter ?? 0, j);
    const lost = num(entry.packetsLost);
    if (lost !== void 0) packetsLost = (packetsLost ?? 0) + Math.max(0, lost);
  }
  return {
    at,
    route: routeFromReport(report),
    rttMs: rtt === void 0 ? void 0 : rtt * 1e3,
    jitterMs: jitter === void 0 ? void 0 : jitter * 1e3,
    bytesSent,
    packetsSent,
    packetsLost
  };
}
function summarize(samples) {
  const rtts = samples.map((sample) => sample.rttMs).filter((value) => value !== void 0);
  const jitters = samples.map((sample) => sample.jitterMs).filter((value) => value !== void 0);
  const first = samples.find((sample) => sample.bytesSent !== void 0);
  const last = [...samples].reverse().find((sample) => sample.bytesSent !== void 0);
  let upstreamKbps;
  if (first && last && last.at > first.at) {
    upstreamKbps = (last.bytesSent - first.bytesSent) * 8 / (last.at - first.at);
  }
  let packetLossPercent;
  const lossFirst = samples.find((sample) => sample.packetsSent !== void 0 && sample.packetsLost !== void 0);
  const lossLast = [...samples].reverse().find((sample) => sample.packetsSent !== void 0 && sample.packetsLost !== void 0);
  if (lossFirst && lossLast && lossLast !== lossFirst) {
    const sent = lossLast.packetsSent - lossFirst.packetsSent;
    const lost = lossLast.packetsLost - lossFirst.packetsLost;
    if (sent > 0) packetLossPercent = Math.max(0, Math.min(100, lost / sent * 100));
  }
  return {
    rttMs: rtts.length > 0 ? rtts.reduce((sum, value) => sum + value, 0) / rtts.length : void 0,
    jitterMs: jitters.length > 0 ? Math.max(...jitters) : void 0,
    packetLossPercent,
    upstreamKbps
  };
}
function turnServersByTransport(iceServers) {
  const groups = /* @__PURE__ */ new Map();
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      if (typeof url !== "string") continue;
      const lower = url.toLowerCase();
      let transport;
      if (lower.startsWith("turns:")) transport = "tls";
      else if (lower.startsWith("turn:")) transport = /[?&]transport=tcp\b/.test(lower) ? "tcp" : "udp";
      if (!transport) continue;
      const list = groups.get(transport) ?? [];
      list.push({ urls: url, username: server.username, credential: server.credential });
      groups.set(transport, list);
    }
  }
  return groups;
}

// src/preflight.ts
var HIGH_RTT_MS = 300;
var HIGH_JITTER_MS = 30;
var PACKET_LOSS_PERCENT = 3;
var LOW_UPSTREAM_KBPS = 300;
var TURN_PROBE_TIMEOUT_MS = 5e3;
var SAMPLE_INTERVAL_MS = 1e3;
var defaultDeps = {
  createAdapter: (logger) => new SwalvoAdapter(logger, false, { adaptiveStream: false, autoSubscribe: false }),
  probeTurn,
  captureCamera: () => createCameraTrack(),
  captureMicrophone: () => createMicrophoneTrack(),
  countDevices: async (kind) => {
    try {
      return (await listDevices(kind)).length;
    } catch {
      return 0;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};
async function runConnectionTest(options, deps = {}) {
  if (!options || typeof options.token !== "string" || !options.token) {
    throw new RTCError("INVALID_TOKEN", "runConnectionTest() needs the RTC token from your backend");
  }
  if (typeof options.endpoint !== "string" || !options.endpoint) {
    throw new RTCError("INVALID_TOKEN", "runConnectionTest() needs the endpoint from the same mint response");
  }
  const d = { ...defaultDeps, ...deps };
  const logger = createLogger(options.logLevel ?? "silent");
  const progress = (stage) => {
    try {
      options.onProgress?.(stage);
    } catch {
    }
  };
  const started = d.now();
  const durationMs = Math.max(0, options.durationMs ?? 5e3);
  const timeoutMs = Math.max(1, options.timeoutMs ?? 15e3);
  const iceServers = options.iceServers ?? [];
  progress("devices");
  const tracks = [];
  const camera = await checkDevice(options.camera !== false, "videoinput", d.captureCamera, d, tracks);
  const microphone = await checkDevice(options.microphone !== false, "audioinput", d.captureMicrophone, d, tracks);
  progress("turn");
  const turnGroups = turnServersByTransport(iceServers);
  const turnProbe = Promise.all(
    ["udp", "tcp", "tls"].map(async (transport) => {
      const servers = turnGroups.get(transport);
      if (!servers || servers.length === 0) return [transport, "skipped"];
      try {
        return [transport, await d.probeTurn(servers, TURN_PROBE_TIMEOUT_MS) ? "passed" : "failed"];
      } catch {
        return [transport, "failed"];
      }
    })
  );
  const adapter = d.createAdapter(logger);
  const signaling = { status: "skipped" };
  const media = { status: "skipped" };
  let route = {};
  const samples = [];
  let published = false;
  try {
    progress("signaling");
    const signalingStart = d.now();
    try {
      await withTimeout(adapter.connect(options.endpoint, options.token, iceServers), timeoutMs, "the room join");
      signaling.status = "passed";
      signaling.durationMs = d.now() - signalingStart;
    } catch (error) {
      Object.assign(signaling, failure(error), { durationMs: d.now() - signalingStart });
    }
    if (signaling.status === "passed") {
      progress("media");
      const mediaStart = d.now();
      const connected = waitForConnected(adapter, timeoutMs);
      for (const track of tracks) {
        try {
          await adapter.publish(track);
          published = true;
        } catch (error) {
          logger.warn("preflight could not publish a track", error.message);
        }
      }
      if (!published) adapter.ensureDataChannel();
      try {
        await connected;
        media.status = "passed";
        media.durationMs = d.now() - mediaStart;
      } catch (error) {
        Object.assign(media, failure(error), { durationMs: d.now() - mediaStart });
      }
    }
    if (media.status === "passed") {
      progress("measuring");
      const end = d.now() + durationMs;
      for (; ; ) {
        const report = await adapter.getStatsReport().catch(() => void 0);
        if (report) samples.push(sampleFromReport(report, d.now()));
        if (d.now() >= end) break;
        await d.sleep(Math.min(SAMPLE_INTERVAL_MS, Math.max(0, end - d.now())));
      }
      route = [...samples].reverse().find((sample) => sample.route.candidateType)?.route ?? {};
    }
  } finally {
    await adapter.disconnect().catch(() => void 0);
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
      }
    }
  }
  const turn = Object.fromEntries(await turnProbe);
  const network = summarize(samples);
  progress("done");
  return {
    ok: signaling.status === "passed" && media.status === "passed",
    startedAt: new Date(started).toISOString(),
    durationMs: d.now() - started,
    camera,
    microphone,
    signaling,
    media,
    route,
    turn,
    network,
    issues: findIssues({ camera, microphone, signaling, media, route, turn, network, published: camera.status === "passed" && published })
  };
}
async function checkDevice(wanted, kind, capture, d, tracks) {
  if (!wanted) return { status: "skipped", devices: await d.countDevices(kind) };
  try {
    const track = await capture();
    tracks.push(track);
    return { status: "passed", devices: await d.countDevices(kind) };
  } catch (error) {
    const { error: code, message } = failure(error);
    return { status: "failed", devices: await d.countDevices(kind), error: code, message };
  }
}
function failure(error) {
  if (error instanceof RTCError) return { status: "failed", error: error.code, message: error.message };
  return { status: "failed", error: "CONNECTION_FAILED", message: error instanceof Error ? error.message : String(error) };
}
function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RTCError("TIMEOUT", `Timed out after ${ms}ms waiting for ${what}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function waitForConnected(adapter, ms) {
  if (adapter.connectionState === "connected") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onState = (state) => {
      if (state === "connected") settle(resolve);
      else if (state === "failed" || state === "disconnected") {
        settle(() => reject(new RTCError("CONNECTION_FAILED", "The media connection did not establish (ICE or DTLS failed)")));
      }
    };
    const timer = setTimeout(
      () => settle(
        () => reject(
          new RTCError(
            "TIMEOUT",
            `The media connection did not establish within ${ms}ms; UDP and TURN may both be blocked`
          )
        )
      ),
      ms
    );
    const settle = (fn) => {
      clearTimeout(timer);
      adapter.off("connectionStateChanged", onState);
      fn();
    };
    adapter.on("connectionStateChanged", onState);
  });
}
async function probeTurn(servers, timeoutMs) {
  if (typeof RTCPeerConnection === "undefined") return false;
  const pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: "relay" });
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const done = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      pc.onicecandidate = (event) => {
        if (!event.candidate) {
          done(false);
          return;
        }
        if (event.candidate.type === "relay" || / typ relay /.test(event.candidate.candidate)) done(true);
      };
      pc.createDataChannel("raven-preflight");
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => done(false));
    });
  } finally {
    pc.onicecandidate = null;
    pc.close();
  }
}
function findIssues(input) {
  const issues = [];
  const { camera, microphone, signaling, media, route, turn, network } = input;
  if (signaling.status === "failed") {
    issues.push({
      code: "CONNECT_FAILED",
      severity: "error",
      message: `Could not reach the service: ${signaling.message ?? "unknown error"}. A firewall or proxy may be blocking secure WebSockets.`
    });
  }
  if (media.status === "failed") {
    issues.push({
      code: "MEDIA_FAILED",
      severity: "error",
      message: "Connected to the service, but audio and video could not get through. Your network may block the ports calls need."
    });
  }
  if (camera.status === "failed") {
    issues.push({ code: "CAMERA_UNAVAILABLE", severity: "warning", message: camera.message ?? "The camera could not be used." });
  }
  if (microphone.status === "failed") {
    issues.push({
      code: "MICROPHONE_UNAVAILABLE",
      severity: "warning",
      message: microphone.message ?? "The microphone could not be used."
    });
  }
  const anyTurn = turn.udp !== "skipped" || turn.tcp !== "skipped" || turn.tls !== "skipped";
  if (anyTurn && turn.udp !== "passed" && turn.tcp !== "passed" && turn.tls !== "passed") {
    issues.push({
      code: "RELAY_UNREACHABLE",
      severity: "warning",
      message: "No relay server could be reached. Calls will fail on networks that block direct connections."
    });
  }
  if (route.usedRelay) {
    issues.push({
      code: "RELAY_REQUIRED",
      severity: "warning",
      message: `Media had to go through a relay${route.relayProtocol ? ` over ${route.relayProtocol.toUpperCase()}` : ""}, which adds latency.`
    });
  }
  const tcpFallbackOnly = route.protocol === "tcp" || route.usedRelay && route.relayProtocol !== "udp";
  if (turn.udp === "failed" || media.status === "passed" && tcpFallbackOnly) {
    issues.push({
      code: "UDP_BLOCKED",
      severity: "warning",
      message: "UDP appears to be blocked, so media falls back to TCP. Expect more delay and choppier video."
    });
  }
  if (network.rttMs !== void 0 && network.rttMs > HIGH_RTT_MS) {
    issues.push({ code: "HIGH_LATENCY", severity: "warning", message: `High latency (${Math.round(network.rttMs)} ms round trip).` });
  }
  if (network.jitterMs !== void 0 && network.jitterMs > HIGH_JITTER_MS) {
    issues.push({ code: "HIGH_JITTER", severity: "warning", message: `Unstable connection (${Math.round(network.jitterMs)} ms jitter).` });
  }
  if (network.packetLossPercent !== void 0 && network.packetLossPercent > PACKET_LOSS_PERCENT) {
    issues.push({
      code: "PACKET_LOSS",
      severity: "warning",
      message: `${network.packetLossPercent.toFixed(1)}% of packets were lost on the way out.`
    });
  }
  if (input.published && network.upstreamKbps !== void 0 && network.upstreamKbps < LOW_UPSTREAM_KBPS) {
    issues.push({
      code: "LOW_UPSTREAM",
      severity: "warning",
      message: `Low upload bandwidth (${Math.round(network.upstreamKbps)} kbit/s). Others may see your video at low quality.`
    });
  }
  return issues;
}

// src/browser-support.ts
function getBrowserSupportDetails() {
  const missing = [];
  if (typeof RTCPeerConnection === "undefined") missing.push("RTCPeerConnection");
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    missing.push("navigator.mediaDevices.getUserMedia");
  if (typeof WebSocket === "undefined") missing.push("WebSocket");
  return { supported: missing.length === 0, missing };
}
function isBrowserSupported() {
  return getBrowserSupportDetails().supported;
}

export { AGENT_IDENTITY_PREFIX, CaptionStore, KeyProvider, LocalParticipant, LocalTrack, Participant, RTCClient, RTCError, RemoteParticipant, RemoteTrack, Room, TRANSCRIBER_IDENTITY_PREFIX, Track, createCustomTrack, createKeyProvider, createRTCClient, createSharedKeyProvider, getBrowserSupportDetails, isAgentIdentity, isBrowserSupported, isE2EESupported, isRTCError, isTranscriberIdentity, runConnectionTest, trackKindToMediaKind };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map