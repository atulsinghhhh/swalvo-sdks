import {
  normalizeTrackStats,
  pickBestLayer,
  type RawTrackStats,
  type TrackStats,
} from './internal/telemetry/track-stats';
import type { VideoLayer } from './internal/media/adaptive-stream';

export type { TrackStats } from './internal/telemetry/track-stats';
/**
 * What a track is of. `screenShareAudio` (phase 7) is the audio of a screen
 * share published with `enableScreenShare({ audio: true })`; it plays like
 * any audio track and the SFU leaves it out of speaker detection.
 */
export type TrackKind = 'camera' | 'microphone' | 'screenShare' | 'screenShareAudio' | 'unknown';

/**
 * Whether the SFU is forwarding a subscribed track to you right now
 * (docs/architecture/phase2-media-contracts.md §4).
 *
 * - `active`: media is flowing.
 * - `paused_bandwidth`: your downlink cannot carry even the lowest layer,
 *   so the SFU's congestion control paused this video until it can. Audio
 *   is never paused this way.
 * - `paused_client`: you asked for it to stop — `track.setEnabled(false)`,
 *   adaptive streaming seeing the element hidden, or `autoSubscribe: false`
 *   before the track was first wanted.
 */
export type TrackSubscriptionState = 'active' | 'paused_bandwidth' | 'paused_client';

/** The simulcast layer the SFU says it is forwarding, or `'off'` when it is forwarding none. */
export type ForwardedLayer = 'low' | 'medium' | 'high' | 'off';

/**
 * The wire-level media vocabulary: what `@swalvo/server`'s `LiveTrackInfo.kind`
 * uses, because that's all a `MediaStreamTrack` actually is once it's
 * published — the SFU has no notion of "camera" vs "screen share", only
 * `audio`/`video`. `TrackKind` is this SDK's richer, capture-source
 * vocabulary; the two are related but not equivalent (a `camera` track and
 * a `screenShare` track are both `video`), so there is no single shared
 * enum — only a one-way mapping.
 */
export type MediaKind = 'audio' | 'video' | 'unknown';

/**
 * Bridges this SDK's `TrackKind` (capture source: camera/microphone/screen
 * share) to the server SDK's `LiveTrackInfo['kind']` (media type: audio/
 * video), so code that has to reconcile a local `Track.kind` against a
 * remote participant's `LiveTrackInfo.kind` doesn't have to hand-roll the
 * mapping. One-way only: going from `audio`/`video` back to `camera` vs
 * `screenShare` is not recoverable from the media type alone.
 */
export function trackKindToMediaKind(kind: TrackKind): MediaKind {
  switch (kind) {
    case 'camera':
    case 'screenShare':
      return 'video';
    case 'microphone':
    case 'screenShareAudio':
      return 'audio';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * A structural interface, not a concrete class, so a track can be backed by
 * a raw `MediaStreamTrack` (what the native adapter does) or by a test
 * double, with neither having to inherit anything.
 */
export interface TrackDelegate {
  readonly mediaStreamTrack: MediaStreamTrack;
  readonly mediaStream?: MediaStream;
  readonly isMuted: boolean;
  attach(element?: HTMLMediaElement): HTMLMediaElement;
  // Typed loosely so a delegate can return one element or an array.
  // Track.detach() below always normalizes to an array, so the public API
  // looks the same either way.
  detach(element?: HTMLMediaElement): HTMLMediaElement | HTMLMediaElement[];
}

/** Base class for local and remote tracks alike. Never leaks RTCRtpSender/Receiver. */
export abstract class Track {
  readonly kind: TrackKind;
  protected readonly delegate: TrackDelegate;

  constructor(delegate: TrackDelegate, kind: TrackKind) {
    this.delegate = delegate;
    this.kind = kind;
  }

  /** The underlying native track, for the rare occasion you need to go deeper. */
  get mediaStreamTrack(): MediaStreamTrack {
    return this.delegate.mediaStreamTrack;
  }

  get mediaStream(): MediaStream | undefined {
    return this.delegate.mediaStream;
  }

  get isMuted(): boolean {
    return this.delegate.isMuted;
  }

  /** Attaches this track to a `<video>`/`<audio>` element, creating one if omitted. */
  attach(element?: HTMLMediaElement): HTMLMediaElement {
    return this.delegate.attach(element);
  }

  /** Detaches this track from one element, or from all elements if omitted. */
  detach(element?: HTMLMediaElement): HTMLMediaElement[] {
    const result = this.delegate.detach(element);
    return Array.isArray(result) ? result : [result];
  }
}

export interface LocalTrackDelegate extends TrackDelegate {
  // Typed `unknown` so a delegate resolving to anything, or to nothing at
  // all, still satisfies the interface. Nobody here uses the value.
  mute(): Promise<unknown>;
  unmute(): Promise<unknown>;
  /**
   * Optional, so a delegate that predates stats support (or a test double
   * that doesn't care) still satisfies this interface untouched. Purely
   * additive, never required. The array form covers video, where a
   * simulcast sender reports one `outbound-rtp` entry per encoding layer
   * instead of a single stream.
   */
  getSenderStats?(): Promise<RawTrackStats | RawTrackStats[] | undefined>;
  /**
   * Swaps the underlying MediaStreamTrack on an already-published sender.
   * `RTCRtpSender.replaceTrack()` manages this without renegotiating, so
   * nobody else in the room sees a thing. Optional for the same reason as
   * getSenderStats: an older delegate or a test double still satisfies
   * this interface, and callers check for it rather than assuming every
   * delegate has it.
   */
  replaceTrack?(track: MediaStreamTrack, userProvidedTrack?: boolean): Promise<unknown>;
}

export interface RemoteTrackDelegate extends TrackDelegate {
  /** Optional for the same reason as `LocalTrackDelegate.getSenderStats`. */
  getReceiverStats?(): Promise<RawTrackStats | undefined>;
}

/** A locally captured track (camera, microphone or screen share), published or not. */
export class LocalTrack extends Track {
  private readonly localDelegate: LocalTrackDelegate;
  private lastSample?: RawTrackStats;

  constructor(delegate: LocalTrackDelegate, kind: TrackKind) {
    super(delegate, kind);
    this.localDelegate = delegate;
  }

  async mute(): Promise<void> {
    await this.localDelegate.mute();
  }

  async unmute(): Promise<void> {
    await this.localDelegate.unmute();
  }

  /** Stops the underlying device capture. Publish state belongs to Room.unpublish(). */
  stop(): void {
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
  async getStats(): Promise<TrackStats | undefined> {
    const raw = await this.localDelegate.getSenderStats?.();
    if (!raw) {
      return undefined;
    }

    const sample = Array.isArray(raw) ? pickBestLayer(raw) : raw;
    if (!sample) {
      return undefined;
    }

    const stats = normalizeTrackStats(sample, this.lastSample, this.kind, 'send');
    this.lastSample = sample;
    return stats;
  }
}

/** A track received from a remote participant, via the SFU. */
export class RemoteTrack extends Track {
  private readonly remoteDelegate: RemoteTrackDelegate;
  private lastSample?: RawTrackStats;

  /**
   * Set by the adapter when the track is subscribed. Undefined on a track
   * built by a test double, which is why every use is optional-chained:
   * a `setLayer()` that threw for want of a controller would make the
   * public API depend on internal wiring.
   */
  private layerController?: {
    request(layer: VideoLayer, options?: { automatic?: boolean }): void;
    observe(element: Element): void;
    unobserve(element: Element): void;
    setEnabled?(enabled: boolean): void;
    setVisible?(visible: boolean): void;
  };

  private _subscriptionState: TrackSubscriptionState = 'active';
  private _layer?: ForwardedLayer;
  private _enabled = true;

  constructor(delegate: RemoteTrackDelegate, kind: TrackKind) {
    super(delegate, kind);
    this.remoteDelegate = delegate;
  }

  /** @internal Wires this track to the adapter's layer control. */
  setLayerController(controller: RemoteTrack['layerController']): void {
    this.layerController = controller;
  }

  /**
   * Whether the SFU is forwarding this track to you. See
   * `TrackSubscriptionState`. Reported by the server; `'active'` against a
   * server that predates it. Changes arrive as the room's
   * `trackSubscriptionStateChanged` event.
   */
  get subscriptionState(): TrackSubscriptionState {
    return this._subscriptionState;
  }

  /**
   * The video layer the SFU last said it is forwarding. Undefined for
   * audio, and until the server has said — which it never will if it
   * predates subscription-state reporting.
   */
  get layer(): ForwardedLayer | undefined {
    return this._layer;
  }

  /** False after `setEnabled(false)`, until `setEnabled(true)`. */
  get isEnabled(): boolean {
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
  setEnabled(enabled: boolean): void {
    if (this.kind === 'microphone') return;
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
  setVisible(visible: boolean): void {
    this.layerController?.setVisible?.(visible);
  }

  /** @internal Applied by the adapter from `subscription.state`. Returns whether anything changed. */
  _setSubscriptionState(state: TrackSubscriptionState, layer: ForwardedLayer | undefined): boolean {
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
  setLayer(layer: VideoLayer): void {
    this.layerController?.request(layer);
  }

  /**
   * Attaches, and starts sizing the subscription to the element.
   *
   * This is what makes `adaptiveStream` work without an application doing
   * anything: the element you render into is the only honest measure of how
   * much resolution this track actually needs.
   */
  attach(element?: HTMLMediaElement): HTMLMediaElement {
    const target = super.attach(element);
    this.layerController?.observe(target);
    return target;
  }

  detach(element?: HTMLMediaElement): HTMLMediaElement[] {
    const detached = super.detach(element);
    for (const el of detached) {
      this.layerController?.unobserve(el);
    }
    return detached;
  }

  /** Live receive-side stats. `LocalTrack.getStats()` covers the shape and the caveats. */
  async getStats(): Promise<TrackStats | undefined> {
    const raw = await this.remoteDelegate.getReceiverStats?.();
    if (!raw) {
      return undefined;
    }

    const stats = normalizeTrackStats(raw, this.lastSample, this.kind, 'receive');
    this.lastSample = raw;
    return stats;
  }
}
