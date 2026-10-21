/**
 * Just enough WebRTC and WebSocket to run under jsdom.
 *
 * jsdom implements neither, and the adapter's job is almost entirely
 * *protocol* logic: which offer to answer, which track belongs to whom,
 * what to send when a publisher mutes. That's worth testing without
 * dragging in a browser, so this supplies the bare minimum of both APIs
 * and exposes the seams a test needs to drive it.
 *
 * What it very by design doesn't do is simulate media. Nothing here
 * encodes, forwards or transports a single byte. Whether media actually
 * flows is settled by the SFU's own tests, which run real Pion
 * PeerConnections against a real forwarding path; see
 * `services/sfu/internal/room/media_test.go`. Faking media here would give
 * us a test that passes while the product is broken, which is worse than
 * having no test at all.
 */

export class FakeMediaStreamTrack implements Partial<MediaStreamTrack> {
  enabled = true;
  readonly muted = false;
  readyState: MediaStreamTrackState = 'live';
  onended: (() => void) | null = null;
  stopped = false;

  constructor(
    readonly kind: 'audio' | 'video',
    readonly id: string,
  ) {}

  stop(): void {
    this.stopped = true;
    this.readyState = 'ended';
  }

  /** Pretends the user hit "Stop sharing" on the browser's own bar. */
  end(): void {
    this.stop();
    this.onended?.();
  }
}

export class FakeMediaStream {
  readonly id: string;
  private readonly tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[] = []) {
    this.tracks = [...tracks];
    this.id = `stream-${Math.random().toString(36).slice(2, 8)}`;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return [...this.tracks];
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

export class FakeRTCRtpSender {
  track: FakeMediaStreamTrack | null;
  private parameters: RTCRtpSendParameters;
  readonly setParametersCalls: RTCRtpSendParameters[] = [];

  constructor(track: FakeMediaStreamTrack | null, encodings: RTCRtpEncodingParameters[]) {
    this.track = track;
    this.parameters = {
      encodings,
      transactionId: 'tx',
      codecs: [],
      headerExtensions: [],
      rtcp: {},
    } as unknown as RTCRtpSendParameters;
  }

  getParameters(): RTCRtpSendParameters {
    return this.parameters;
  }

  async setParameters(parameters: RTCRtpSendParameters): Promise<void> {
    this.setParametersCalls.push(parameters);
    this.parameters = parameters;
  }

  async replaceTrack(track: FakeMediaStreamTrack | null): Promise<void> {
    this.track = track;
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }
}

export class FakeRTCRtpReceiver {
  constructor(readonly track: FakeMediaStreamTrack) {}

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }
}

export class FakeRTCDataChannel {
  /**
   * Starts `connecting`, like a real one.
   *
   * A channel is only usable once its m-section has been negotiated and
   * SCTP has come up. A fake that reported `open` on creation made
   * `sendData()` look like it worked while the real thing threw "The data
   * channel is not open yet".
   */
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'arraybuffer';
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  constructor(
    readonly label: string,
    readonly init?: RTCDataChannelInit,
  ) {}

  /** What the SCTP association coming up looks like from the page. */
  open(): void {
    if (this.readyState !== 'connecting') {
      return;
    }
    this.readyState = 'open';
    this.onopen?.();
  }

  send(payload: unknown): void {
    if (this.readyState !== 'open') {
      throw new Error(`InvalidStateError: RTCDataChannel.readyState is not 'open'`);
    }
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.readyState = 'closed';
    this.onclose?.();
  }

  /** Pretends a message arrived from another participant, via the SFU. */
  receive(payload: ArrayBuffer | string): void {
    this.onmessage?.({ data: payload } as MessageEvent);
  }
}

/**
 * A PeerConnection that remembers what was asked of it and lets a test
 * drive its callbacks.
 *
 * `signalingState` is tracked honestly, because the adapter's glare
 * avoidance leans on it. A fake that always claimed `'stable'` would make
 * the deferred-publish path untestable.
 */
/** What a transceiver looks like from the outside, which is all a test needs. */
export interface FakeTransceiver {
  mid: string;
  kind: 'audio' | 'video';
  sender: FakeRTCRtpSender;
  direction: RTCRtpTransceiverDirection;
  currentDirection: RTCRtpTransceiverDirection | null;
  /**
   * The simulcast layer ids this m-section declares.
   *
   * Only ever populated from `addTransceiver`'s `sendEncodings`, never from
   * `setParameters`, because that is the real constraint: a sender's
   * encoding count is fixed once it exists. A fake that let `setParameters`
   * add RIDs would make the broken implementation pass, which is exactly
   * what the previous version of these tests did.
   */
  rids: string[];
  /** Like `RTCRtpTransceiver.stop()`: permanent, and it needs a renegotiation. */
  stop?: () => void;
  /** What `setCodecPreferences` was last given, in order. */
  codecPreferences?: RTCRtpCodec[];
  setCodecPreferences?: (codecs: RTCRtpCodec[]) => void;
}

/**
 * A PeerConnection that enforces the real signaling state machine.
 *
 * The strictness is the point. An earlier version tracked `signalingState`
 * but applied any description it was handed, so the adapter's
 * check-then-act glare avoidance passed its tests and still threw
 * "Called in wrong state: have-remote-offer" in Chrome. These throws carry
 * the same wording a browser uses, so a serialization regression fails a
 * test instead of shipping.
 *
 * What this still doesn't do is simulate media. Nothing here encodes,
 * forwards or transports a byte; whether media actually flows is settled
 * by the SFU's own tests against real Pion PeerConnections
 * (`services/sfu/internal/room/media_test.go`) and by the browser run in
 * `docs/repro/dtls-role-probe.md`.
 */
export class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];

  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  closed = false;

  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;

  /**
   * The browser's negotiation-needed bit, modelled.
   *
   * Local changes (a track added or removed, a data channel created) make
   * the current local description out of date; applying a local
   * description brings it up to date again, whichever side offered. That
   * last part is the whole reason the adapter leans on this event rather
   * than its own flag: an SFU offer that already carries our new sender
   * clears the bit, and no further offer is needed. A fake without this
   * would let an offer/rollback loop pass its tests.
   */
  private pendingLocalChanges = 0;
  /** `pendingLocalChanges` as of the offer currently on the wire, for rollback. */
  private changesCoveredByOffer = 0;
  /** How many times `negotiationneeded` has fired. */
  negotiationNeededCount = 0;

  /**
   * Whether an incoming offer has m-sections for our pending local
   * changes, so answering it covers them and no offer of our own is
   * needed.
   *
   * False by default, which is the conservative case: a subscription-only
   * offer leaves our new sender unnegotiated, the bit stays set, and we
   * offer once the round ends. Swalvo's SFU often *does* carry a declared
   * track in its own offer, and that case is the one that used to loop, so
   * it gets tested explicitly rather than assumed either way.
   */
  offerCoversPendingChanges = false;

  readonly senders: FakeRTCRtpSender[] = [];
  readonly addedTracks: FakeMediaStreamTrack[] = [];
  readonly removedSenders: FakeRTCRtpSender[] = [];
  readonly appliedCandidates: RTCIceCandidateInit[] = [];
  readonly dataChannels: FakeRTCDataChannel[] = [];
  readonly transceivers: FakeTransceiver[] = [];
  /** Every description this connection applied, in order. */
  readonly descriptions: Array<{ side: 'local' | 'remote'; type: string }> = [];
  /**
   * Descriptions it was asked to apply in a state that could not take
   * them. A test asserting "never call setRemoteDescription in the wrong
   * state" needs the attempt, not just the outcome.
   */
  readonly refusedDescriptions: Array<{ side: 'local' | 'remote'; type: string; state: RTCSignalingState }> = [];
  /** Encodings the next sender created by addTrack will get. */
  nextSenderEncodings: RTCRtpEncodingParameters[] = [{}];

  /**
   * Runs inside `createOffer()`, before it resolves.
   *
   * The seam for reproducing the publish race: a test can deliver the
   * SFU's offer here, exactly in the window where the old code checked
   * `signalingState` and then awaited.
   */
  beforeCreateOffer?: () => void | Promise<void>;

  /**
   * Held inside `createAnswer()` until a test resolves it.
   *
   * Lets a test freeze a remote round *mid-way* — remote description
   * applied, answer not yet built — which is the window that produced
   * "Called in wrong state: have-remote-offer" in Chrome. Without it, an
   * interfering offer completes its whole round inside one `flush()` and
   * the connection is back to `stable` before the racing offer lands, so
   * the bug hides.
   */
  pauseCreateAnswer?: Promise<void>;

  constructor(readonly configuration?: RTCConfiguration) {
    FakeRTCPeerConnection.instances.push(this);
  }

  static reset(): void {
    FakeRTCPeerConnection.instances = [];
  }

  static get latest(): FakeRTCPeerConnection {
    const instance = FakeRTCPeerConnection.instances.at(-1);
    if (!instance) {
      throw new Error('no FakeRTCPeerConnection has been created');
    }
    return instance;
  }

  addTrack(track: FakeMediaStreamTrack): FakeRTCRtpSender {
    this.markLocalChange();
    this.addedTracks.push(track);

    // Reuse a free receive-only transceiver of the same kind before
    // creating one, which is what `RTCPeerConnection.addTrack()` does.
    // The reused m-section keeps whatever msid it arrived with.
    const reusable = this.transceivers.find(
      (candidate) =>
        candidate.kind === track.kind && candidate.direction === 'recvonly' && candidate.sender.track === null,
    );
    if (reusable) {
      reusable.sender.track = track;
      reusable.direction = 'sendrecv';
      this.senders.push(reusable.sender);
      reusable.setCodecPreferences ??= (codecs) => {
        reusable.codecPreferences = [...codecs];
      };
      return reusable.sender;
    }

    const sender = new FakeRTCRtpSender(track, this.nextSenderEncodings);
    this.senders.push(sender);
    const created: FakeTransceiver = {
      mid: String(this.transceivers.length),
      kind: track.kind,
      sender,
      direction: 'sendrecv',
      currentDirection: null,
      // addTrack cannot produce RIDs. That is the whole constraint.
      rids: [],
    };
    created.setCodecPreferences = (codecs) => {
      created.codecPreferences = [...codecs];
    };
    this.transceivers.push(created);
    return sender;
  }

  removeTrack(sender: FakeRTCRtpSender): void {
    this.markLocalChange();
    this.removedSenders.push(sender);
    sender.track = null;
    const transceiver = this.transceivers.find((entry) => entry.sender === sender);
    if (transceiver) {
      transceiver.direction = 'recvonly';
    }
  }

  /**
   * A transceiver of its own for an outgoing track, which is what the
   * adapter uses so the m-section carries our `msid` and not one
   * inherited from the SFU's offer.
   */
  addTransceiver(
    track: FakeMediaStreamTrack,
    init?: {
      direction?: RTCRtpTransceiverDirection;
      streams?: FakeMediaStream[];
      sendEncodings?: RTCRtpEncodingParameters[];
    },
  ): FakeTransceiver {
    this.markLocalChange();
    this.addedTracks.push(track);

    // The encodings the caller declared *become* the sender's, which is
    // what a browser does and what `addTrack` cannot do. Recorded here so
    // `getParameters()` reports them back and the adapter's own
    // confirmation step has something real to read.
    const encodings = init?.sendEncodings ?? this.nextSenderEncodings;
    this.transceiverInits.push(init ?? {});

    const sender = new FakeRTCRtpSender(track, encodings);
    this.senders.push(sender);
    const transceiver: FakeTransceiver = {
      mid: String(this.transceivers.length),
      kind: track.kind,
      sender,
      direction: init?.direction ?? 'sendrecv',
      currentDirection: null,
      rids: encodings
        .map((encoding) => encoding.rid)
        .filter((rid): rid is string => typeof rid === 'string' && rid.length > 0),
    };
    transceiver.setCodecPreferences = (codecs) => {
      transceiver.codecPreferences = [...codecs];
    };
    transceiver.stop = () => {
      this.markLocalChange();
      transceiver.direction = 'stopped';
      transceiver.currentDirection = 'stopped';
      sender.track = null;
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  /** Every `addTransceiver` init, in order, for assertions. */
  readonly transceiverInits: Array<{
    direction?: RTCRtpTransceiverDirection;
    streams?: FakeMediaStream[];
    sendEncodings?: RTCRtpEncodingParameters[];
  }> = [];

  getSenders(): FakeRTCRtpSender[] {
    return [...this.senders];
  }

  getTransceivers(): FakeTransceiver[] {
    return [...this.transceivers];
  }

  createDataChannel(label: string, init?: RTCDataChannelInit): FakeRTCDataChannel {
    this.markLocalChange();
    const channel = new FakeRTCDataChannel(label, init);
    this.dataChannels.push(channel);
    return channel;
  }

  /** A local change that the current local description does not cover. */
  private markLocalChange(): void {
    this.pendingLocalChanges++;
    this.maybeFireNegotiationNeeded();
  }

  /**
   * Fires `negotiationneeded`, on a task and only while stable — which is
   * what a browser does. Firing synchronously from `addTrack()` would let
   * a caller's own follow-up change miss the coalescing window.
   */
  private maybeFireNegotiationNeeded(): void {
    if (this.pendingLocalChanges === 0 || this.signalingState !== 'stable' || this.closed) {
      return;
    }
    queueMicrotask(() => {
      if (this.pendingLocalChanges === 0 || this.signalingState !== 'stable' || this.closed) {
        return;
      }
      this.negotiationNeededCount++;
      this.onnegotiationneeded?.();
    });
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    await this.beforeCreateOffer?.();
    return { type: 'offer', sdp: this.describe('fake-client-offer') };
  }

  /**
   * An SDP listing the senders this connection currently has, as
   * `a=msid:` lines.
   *
   * Enough shape for the one thing the adapter reads out of its own local
   * description: whether each published track's id is actually announced.
   * A fake returning a fixed string made that check untestable, and the
   * check exists because Swalvo's SFU identifies tracks by exactly this.
   */
  private describe(label: string): string {
    const lines = ['v=0', `s=${label}`];
    for (const transceiver of this.transceivers) {
      lines.push(`m=${transceiver.kind} 9 UDP/TLS/RTP/SAVPF 96`);
      lines.push(`a=mid:${transceiver.mid}`);
      const trackId =
        this.msidOverrides.get(transceiver.mid) ?? this.pinnedMsid.get(transceiver.mid) ?? transceiver.sender.track?.id;
      if (trackId) {
        lines.push(`a=msid:stream-${transceiver.mid} ${trackId}`);
      }

      // RFC 8853, for the part that matters here: a send transceiver
      // carrying RIDs gets one `a=rid:<id> send` per layer and a single
      // `a=simulcast:send` line. This is the only place the claim "this
      // publishes simulcast" is falsifiable — an encodings array in memory
      // is exactly what the broken implementation had.
      if (transceiver.rids.length > 0) {
        lines.push('a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid');
        lines.push('a=extmap:2 urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id');
        for (const rid of transceiver.rids) {
          lines.push(`a=rid:${rid} send`);
        }
        lines.push(`a=simulcast:send ${transceiver.rids.join(';')}`);
      }
    }
    return lines.join('\r\n');
  }

  /**
   * Pins the msid a m-section announces, whatever track is attached.
   *
   * Models the case that matters: the SFU pre-created a receive slot,
   * `addTrack` reused that transceiver, and the SFU's own offer covered
   * the m-line — so the wire still carries the SFU's msid and not ours.
   */
  readonly msidOverrides = new Map<string, string>();

  /**
   * The msid an m-section the *remote* side created already carries, by
   * mid.
   *
   * Swalvo's SFU adds a recvonly transceiver per kind to every offer, so a
   * first publish costs no extra renegotiation. `addTrack` reuses those,
   * and the m-section keeps the msid it came with — a browser will not
   * rewrite an id it did not author. That is the whole mechanism behind a
   * screen share arriving labelled as a camera, so the fake reproduces it
   * rather than leaving it to a hand-set override.
   */
  private readonly pinnedMsid = new Map<string, string>();

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    if (this.pauseCreateAnswer) {
      await this.pauseCreateAnswer;
    }
    if (this.signalingState !== 'have-remote-offer' && this.signalingState !== 'have-local-pranswer') {
      throw new Error(`InvalidStateError: Called in wrong state: ${this.signalingState}`);
    }
    return { type: 'answer', sdp: this.describe('fake-client-answer') };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const type = description.type;
    if (type === 'rollback') {
      if (this.signalingState !== 'have-local-offer') {
        this.refuse('local', type);
      }
      this.localDescription = null;
      this.signalingState = 'stable';
      this.descriptions.push({ side: 'local', type: 'rollback' });
      // Whatever that offer was going to cover is uncovered again.
      this.pendingLocalChanges += this.changesCoveredByOffer;
      this.changesCoveredByOffer = 0;
      this.maybeFireNegotiationNeeded();
      return;
    }

    if (type === 'offer') {
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') {
        this.refuse('local', type, 'Failed to set local offer sdp');
      }
      this.signalingState = 'have-local-offer';
      this.changesCoveredByOffer = this.pendingLocalChanges;
      this.pendingLocalChanges = 0;
    } else {
      // answer / pranswer
      if (this.signalingState !== 'have-remote-offer' && this.signalingState !== 'have-local-pranswer') {
        this.refuse('local', type, 'Failed to set local answer sdp');
      }
      this.signalingState = 'stable';
      // An answer is a local description too, but it can only cover what
      // the offer it answers had room for.
      if (this.offerCoversPendingChanges) {
        this.pendingLocalChanges = 0;
      }
      this.changesCoveredByOffer = 0;
    }

    this.localDescription = description as RTCSessionDescription;
    this.descriptions.push({ side: 'local', type });
    if (this.signalingState === 'stable') {
      this.completeNegotiation();
      this.maybeFireNegotiationNeeded();
    }
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const type = description.type;
    if (type === 'offer') {
      // Chrome rolls back implicitly here; this fake refuses, so the
      // adapter has to roll back deliberately and the polite-glare path
      // stays covered.
      if (this.signalingState !== 'stable' && this.signalingState !== 'have-remote-offer') {
        this.refuse('remote', type, 'Failed to set remote offer sdp');
      }
      this.signalingState = 'have-remote-offer';
    } else {
      if (this.signalingState !== 'have-local-offer') {
        this.refuse('remote', type, 'Failed to set remote answer sdp');
      }
      this.signalingState = 'stable';
      // Our offer is now agreed, so what it covered stays covered.
      this.changesCoveredByOffer = 0;
    }

    if (type === 'offer') {
      this.adoptRemoteSections(description.sdp ?? '');
    }

    this.remoteDescription = description as RTCSessionDescription;
    this.descriptions.push({ side: 'remote', type });
    if (this.signalingState === 'stable') {
      this.completeNegotiation();
      this.maybeFireNegotiationNeeded();
    }
  }

  /**
   * Creates a receive-only transceiver for every m-section in a remote
   * offer we have no transceiver for yet, pinning the msid the offer
   * carried.
   *
   * An offer with no m-sections (most of these tests) changes nothing.
   */
  private adoptRemoteSections(sdp: string): void {
    const sections = sdp.split(/\r?\nm=/).slice(1);
    for (const section of sections) {
      const kind = section.startsWith('audio') ? 'audio' : section.startsWith('video') ? 'video' : undefined;
      if (!kind) {
        continue;
      }
      const mid = (/a=mid:(\S+)/.exec(section) ?? [])[1];
      if (!mid || this.transceivers.some((transceiver) => transceiver.mid === mid)) {
        continue;
      }
      const msid = (/a=msid:\S+\s+(\S+)/.exec(section) ?? [])[1];
      if (msid) {
        this.pinnedMsid.set(mid, msid);
      }
      this.transceivers.push({
        mid,
        kind,
        sender: new FakeRTCRtpSender(null, this.nextSenderEncodings),
        direction: 'recvonly',
        // A transceiver the SFU created to receive from us. It can never
        // carry a ladder, which is why a simulcast publish creates its own
        // rather than reusing one of these.
        rids: [],
        currentDirection: null,
      });
    }
  }

  /** Records the attempt and then throws what a browser would throw. */
  private refuse(side: 'local' | 'remote', type: string, prefix?: string): never {
    this.refusedDescriptions.push({ side, type, state: this.signalingState });
    const detail = prefix ? `${prefix}: ` : '';
    throw new Error(`InvalidStateError: ${detail}Called in wrong state: ${this.signalingState}`);
  }

  /**
   * What settling a round trip does to everything downstream of it: senders
   * start sending, and the SCTP association behind a data channel comes up.
   */
  private completeNegotiation(): void {
    for (const transceiver of this.transceivers) {
      transceiver.currentDirection = transceiver.sender.track ? 'sendrecv' : 'recvonly';
    }
    for (const channel of this.dataChannels) {
      channel.open();
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.appliedCandidates.push(candidate);
  }

  async getStats(): Promise<RTCStatsReport> {
    return new Map() as unknown as RTCStatsReport;
  }

  close(): void {
    this.closed = true;
    this.connectionState = 'closed';
    this.signalingState = 'closed';
  }

  // --- Test drivers ------------------------------------------------------

  setConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  emitIceCandidate(candidate: Partial<RTCIceCandidate>): void {
    this.onicecandidate?.({ candidate } as RTCPeerConnectionIceEvent);
  }

  /** The sender currently carrying a track of this kind, if any. */
  activeSenders(kind: 'audio' | 'video'): FakeRTCRtpSender[] {
    return this.senders.filter((sender) => sender.track?.kind === kind);
  }

  /**
   * Fires `ontrack`, optionally with the transceiver `mid` a real browser
   * would have attached.
   *
   * `mid` matters because the remote track id lives in the SDP's `a=msid:`
   * line and not on the track. Chrome mints its own id for a received
   * track. Any test wanting to exercise that has to supply the mid so the
   * adapter can locate the right m-section. Leave it off and you get a
   * stack that reports no mid, where the adapter falls back to `track.id`.
   */
  emitTrack(track: FakeMediaStreamTrack, mid?: string): FakeRTCRtpReceiver {
    const receiver = new FakeRTCRtpReceiver(track);
    this.ontrack?.({
      track,
      receiver,
      streams: [new FakeMediaStream([track])],
      transceiver: mid === undefined ? undefined : ({ mid } as RTCRtpTransceiver),
    } as unknown as RTCTrackEvent);
    return receiver;
  }

  emitDataChannel(label: string): FakeRTCDataChannel {
    const channel = new FakeRTCDataChannel(label);
    channel.open();
    this.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent);
    return channel;
  }
}

/** A WebSocket a test can poke at and feed messages into. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 0;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  readonly sent: string[] = [];
  closeCode?: number;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    // Opens on a microtask so a caller gets to attach handlers first,
    // which is what a real WebSocket does anyway.
    void Promise.resolve().then(() => this.open());
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  static get latest(): FakeWebSocket {
    const instance = FakeWebSocket.instances.at(-1);
    if (!instance) {
      throw new Error('no FakeWebSocket has been created');
    }
    return instance;
  }

  open(): void {
    this.readyState = this.OPEN;
    this.onopen?.();
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number): void {
    this.closeCode = code;
    this.readyState = this.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: '' } as CloseEvent);
  }

  /** Delivers a server message. */
  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }

  /** Everything the client sent, parsed. */
  sentMessages(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  lastSent(type: string): Record<string, unknown> | undefined {
    return this.sentMessages()
      .reverse()
      .find((message) => message.type === type);
  }
}

/**
 * Installs the fakes on `globalThis` and hands back a teardown.
 *
 * Per test, not once in setup, so a test needing different behaviour can
 * swap one out, and so a leaked handler can't reach into the next test.
 */
export function installFakeWebRTC(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    RTCPeerConnection: globals.RTCPeerConnection,
    WebSocket: globals.WebSocket,
    MediaStream: globals.MediaStream,
    navigator: globals.navigator,
  };

  FakeRTCPeerConnection.reset();
  FakeWebSocket.reset();

  globals.RTCPeerConnection = FakeRTCPeerConnection;
  globals.WebSocket = FakeWebSocket;
  globals.MediaStream = FakeMediaStream;

  return () => {
    globals.RTCPeerConnection = saved.RTCPeerConnection;
    globals.WebSocket = saved.WebSocket;
    globals.MediaStream = saved.MediaStream;
    globals.navigator = saved.navigator;
  };
}

/** Stubs `navigator.mediaDevices` so capture resolves to fake tracks. */
export function installFakeMediaDevices(options: { devices?: MediaDeviceInfo[] } = {}): void {
  const mediaDevices = {
    getUserMedia: async (constraints: MediaStreamConstraints) => {
      const kind: 'audio' | 'video' = constraints.audio ? 'audio' : 'video';
      return new FakeMediaStream([new FakeMediaStreamTrack(kind, `local-${kind}`)]);
    },
    getDisplayMedia: async () => new FakeMediaStream([new FakeMediaStreamTrack('video', 'local-screen')]),
    enumerateDevices: async () => options.devices ?? [],
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { ...(globalThis.navigator ?? {}), mediaDevices },
  });
}

/** Builds an unsigned Swalvo RTC token the SDK can read claims off. */
export function fakeToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature-not-checked-by-the-client`;
}

/** Lets queued microtasks and zero-delay timers actually run. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}
