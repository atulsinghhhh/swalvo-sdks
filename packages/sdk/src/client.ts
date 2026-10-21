import {
  assertTokenMatchesRoom,
  decodeTokenPayload,
  validateConfig,
  type ResolvedRTCClientConfig,
  type RTCClientConfig,
} from './config';
import { RTCError } from './errors';
import { createLogger, type Logger } from './logger';
import { listDevices } from './internal/devices/enumerate';
import {
  createCameraTrack,
  createCustomTrack,
  createMicrophoneTrack,
  createScreenShareTrack,
  type CustomTrackOptions,
} from './internal/media/capture';
import { SwalvoAdapter, type AdapterOptions } from './internal/sfu/swalvo-adapter';
import type { DeviceInfo, DeviceKind, SFUAdapter } from './internal/sfu/types';
import { createTelemetryClient } from './internal/telemetry/telemetry-client';
import { Room, type ConnectionDiagnostics } from './room';
import { LocalTrack } from './track';
import { SDK_VERSION } from './version';

/**
 * Third parameter is optional so an existing custom factory keeps
 * compiling; a factory that ignores it simply gets the default behaviour.
 */
type AdapterFactory = (logger: Logger, autoReconnect: boolean, options?: AdapterOptions) => SFUAdapter;

const defaultAdapterFactory: AdapterFactory = (logger, autoReconnect, options) =>
  new SwalvoAdapter(logger, autoReconnect, options);

/**
 * The SDK's entry point. Holds your RTC token and endpoint and gets you
 * into a room. Everything per-room lives on the `Room` it hands back.
 */
export class RTCClient {
  private readonly config: ResolvedRTCClientConfig;
  private readonly logger: Logger;
  private readonly adapterFactory: AdapterFactory;
  private currentRoom?: Room;

  /**
   * @internal Use `createRTCClient(config)`. The second param exists purely
   * so tests can inject a fake SFUAdapter without a real browser and WebRTC
   * stack. Not part of the public config.
   */
  constructor(config: ResolvedRTCClientConfig, adapterFactory: AdapterFactory = defaultAdapterFactory) {
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
  async join(roomId?: string): Promise<Room> {
    const target = roomId ?? roomFromToken(this.config.token);
    assertTokenMatchesRoom(this.config.token, target);
    this.logger.info('joining room', target);

    const telemetry = createTelemetryClient({
      enabled: this.config.telemetry,
      telemetryUrl: this.config.telemetryUrl,
      token: this.config.token,
      sdkVersion: SDK_VERSION,
      logger: this.logger,
    });
    telemetry.send('connection_started');

    const adapter = this.adapterFactory(this.logger, this.config.autoReconnect, {
      adaptiveStream: this.config.adaptiveStream,
      preferredVideoCodec: this.config.preferredVideoCodec,
      audioRed: this.config.audioRed,
      e2ee: this.config.e2ee,
      refreshToken: this.config.refreshToken,
      autoSubscribe: this.config.autoSubscribe,
    });
    const room = new Room(adapter, target, this.logger, telemetry);

    try {
      await adapter.connect(this.config.endpoint, this.config.token, this.config.iceServers);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof RTCError ? error.code : 'CONNECTION_FAILED';
      telemetry.send('error', { code, message });
      telemetry.send('connection_failed');
      throw error;
    }

    this.currentRoom = room;
    return room;
  }

  /** Leaves the most recently joined room, if there is one. Same as `.leave()` on that `Room`. */
  async leave(): Promise<void> {
    await this.currentRoom?.leave();
    this.currentRoom = undefined;
  }

  /** Captures a camera track without joining or publishing. Pair it with `room.publish(track)`. */
  async createCameraTrack(deviceId?: string): Promise<LocalTrack> {
    return createCameraTrack(deviceId ? { deviceId } : {});
  }

  /** Captures a microphone track without joining or publishing. Pair it with `room.publish(track)`. */
  async createMicrophoneTrack(deviceId?: string): Promise<LocalTrack> {
    return createMicrophoneTrack(deviceId ? { deviceId } : {});
  }

  /** Captures a screen-share track without joining or publishing. Pair it with `room.publish(track)`. */
  async createScreenShareTrack(): Promise<LocalTrack> {
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
  createCustomTrack(mediaStreamTrack: MediaStreamTrack, options: CustomTrackOptions = {}): LocalTrack {
    return createCustomTrack(mediaStreamTrack, options);
  }

  /** Lists available devices. Labels only fill in once permission has been granted at least once. */
  async getDevices(kind?: DeviceKind): Promise<DeviceInfo[]> {
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
  onDeviceChange(callback: () => void): () => void {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return () => {};
    }
    navigator.mediaDevices.addEventListener('devicechange', callback);
    return () => navigator.mediaDevices.removeEventListener('devicechange', callback);
  }

  /** Switches the active camera on the currently joined room. */
  async setCamera(deviceId: string): Promise<void> {
    if (!this.currentRoom) {
      throw new RTCError('CONNECTION_FAILED', 'setCamera() requires an active room; call join() first');
    }
    await this.currentRoom.setCameraDevice(deviceId);
  }

  /** Switches the active microphone on the currently joined room. */
  async setMicrophone(deviceId: string): Promise<void> {
    if (!this.currentRoom) {
      throw new RTCError('CONNECTION_FAILED', 'setMicrophone() requires an active room; call join() first');
    }
    await this.currentRoom.setMicrophoneDevice(deviceId);
  }

  /** Diagnostic snapshot of the currently joined room. See `Room.getDiagnostics()`. */
  getDiagnostics(): ConnectionDiagnostics {
    if (!this.currentRoom) {
      throw new RTCError('CONNECTION_FAILED', 'getDiagnostics() requires an active room; call join() first');
    }
    return this.currentRoom.getDiagnostics();
  }
}

/**
 * The room a token was minted for, preferring the name over the id because
 * that is what application code and logs deal in.
 *
 * Only reached when `join()` is called with no argument; `join('room')`
 * never needs it.
 */
function roomFromToken(token: string): string {
  const { roomName, roomId } = decodeTokenPayload(token);
  const room = roomName ?? roomId;
  if (!room) {
    throw new RTCError(
      'ROOM_NOT_FOUND',
      'join() with no argument needs the room from the token, but this token carries neither an "rnm" nor an "rid" claim. Pass the room explicitly: join(roomName).',
    );
  }
  return room;
}

/**
 * Creates an RTC client from a token your backend minted. `token` and
 * `endpoint` come straight out of that same mint response. Don't build
 * them by hand, and never mint a token in the browser.
 */
export function createRTCClient(config: RTCClientConfig): RTCClient {
  const resolved = validateConfig(config);
  return new RTCClient(resolved);
}
