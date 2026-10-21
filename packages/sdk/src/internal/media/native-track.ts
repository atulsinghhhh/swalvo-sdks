import type { LocalTrackDelegate, RemoteTrackDelegate } from '../../track';
import { rawStatsFromReport, type RawTrackStats } from '../telemetry/rtc-stats';

/**
 * Attach/detach over a plain `MediaStreamTrack`.
 *
 * `Track.attach()` is how the SDK gets media onto a page without anyone
 * touching `srcObject`. The job itself is small: wrap the track in a
 * `MediaStream`, point an element at it, and remember which elements you
 * attached so `detach()` can find them later.
 *
 * That last bit is the part worth getting right. Skip the bookkeeping and
 * `detach()` with no argument has nothing to detach *from*, at which point
 * the standard React cleanup path quietly leaks a playing video.
 */
abstract class NativeTrackDelegate {
  readonly mediaStreamTrack: MediaStreamTrack;
  private stream?: MediaStream;
  private readonly attachedElements = new Set<HTMLMediaElement>();

  constructor(mediaStreamTrack: MediaStreamTrack) {
    this.mediaStreamTrack = mediaStreamTrack;
  }

  get mediaStream(): MediaStream | undefined {
    if (!this.stream && typeof MediaStream !== 'undefined') {
      this.stream = new MediaStream([this.mediaStreamTrack]);
    }
    return this.stream;
  }

  attach(element?: HTMLMediaElement): HTMLMediaElement {
    const target = element ?? this.createElement();
    const stream = this.mediaStream;
    if (stream) {
      target.srcObject = stream;
    }
    // Autoplay policies block an unmuted video element until the user has
    // interacted with the page. A remote track needs to be audible, so we
    // don't mute it. `autoplay` plus `playsInline` covers the cases that
    // are allowed, and anyone needing finer control passes their own
    // element.
    target.autoplay = true;
    if (target instanceof HTMLVideoElement) {
      target.playsInline = true;
    }
    this.attachedElements.add(target);
    return target;
  }

  detach(element?: HTMLMediaElement): HTMLMediaElement | HTMLMediaElement[] {
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
  protected swapMediaStreamTrack(next: MediaStreamTrack): void {
    (this as { mediaStreamTrack: MediaStreamTrack }).mediaStreamTrack = next;
    this.stream = typeof MediaStream !== 'undefined' ? new MediaStream([next]) : undefined;
    const stream = this.stream;
    if (!stream) {
      return;
    }
    for (const element of this.attachedElements) {
      element.srcObject = stream;
    }
  }

  private createElement(): HTMLMediaElement {
    if (typeof document === 'undefined') {
      throw new Error('attach() without an element requires a DOM');
    }
    return document.createElement(this.mediaStreamTrack.kind === 'video' ? 'video' : 'audio');
  }
}

/**
 * A locally captured track, which may or may not have an `RTCRtpSender`.
 *
 * The sender arrives after publishing, not at construction. You can capture
 * a track for a preview and publish it later (`client.createCameraTrack()`
 * then `room.publish(track)`), and mute has to work in both states.
 */
export class NativeLocalTrackDelegate extends NativeTrackDelegate implements LocalTrackDelegate {
  private sender?: RTCRtpSender;
  private muted = false;

  get isMuted(): boolean {
    return this.muted;
  }

  /** @internal Called by the adapter once the track has a sender. */
  setSender(sender: RTCRtpSender | undefined): void {
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
  async mute(): Promise<unknown> {
    this.mediaStreamTrack.enabled = false;
    this.muted = true;
    return undefined;
  }

  async unmute(): Promise<unknown> {
    this.mediaStreamTrack.enabled = true;
    this.muted = false;
    return undefined;
  }

  /**
   * Replaces the outgoing track without renegotiating.
   *
   * This is the trick that makes Swalvo Effects work mid-call.
   * `RTCRtpSender.replaceTrack` swaps the source of an established stream,
   * so a processed video track takes over from the raw camera with no
   * offer/answer and nobody else in the room noticing.
   */
  async replaceTrack(track: MediaStreamTrack, _userProvidedTrack?: boolean): Promise<unknown> {
    if (this.sender) {
      await this.sender.replaceTrack(track);
    }
    // Applied with or without a sender, so an unpublished track's preview
    // follows the swap too.
    this.swapMediaStreamTrack(track);
    if (this.muted) {
      track.enabled = false;
    }
    return undefined;
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
  async getSenderStats(): Promise<RawTrackStats | RawTrackStats[] | undefined> {
    if (!this.sender) {
      return undefined;
    }
    const report = await this.sender.getStats();
    const samples = rawStatsFromReport(report, 'outbound-rtp');
    if (samples.length === 0) {
      return undefined;
    }
    return samples.length === 1 ? samples[0] : samples;
  }
}

/**
 * A track received from a remote participant.
 *
 * `isMuted` is the *publisher's* mute, as reported by the SFU over
 * signaling. It is not `mediaStreamTrack.muted`, which in a browser means
 * "nothing arriving right now" and flickers true during perfectly ordinary
 * network jitter. Drive a UI off that and it flashes a muted badge on a
 * completely healthy connection.
 */
export class NativeRemoteTrackDelegate extends NativeTrackDelegate implements RemoteTrackDelegate {
  private readonly receiver: RTCRtpReceiver;
  private publisherMuted = false;

  constructor(mediaStreamTrack: MediaStreamTrack, receiver: RTCRtpReceiver) {
    super(mediaStreamTrack);
    this.receiver = receiver;
  }

  get isMuted(): boolean {
    return this.publisherMuted;
  }

  /** @internal Set from the SFU's `track.muted` / `track.unmuted` events. */
  setPublisherMuted(muted: boolean): void {
    this.publisherMuted = muted;
  }

  async getReceiverStats(): Promise<RawTrackStats | undefined> {
    const report = await this.receiver.getStats();
    const [sample] = rawStatsFromReport(report, 'inbound-rtp');
    return sample;
  }
}
