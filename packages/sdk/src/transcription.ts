/**
 * Live transcription captions and AI voice agents, as a client sees them
 * (docs/architecture/phase6-contracts.md §4, §8).
 *
 * The server pushes three messages over the room's signaling socket:
 * `transcription.segment`, `transcription.state` and `agent.state`. `Room`
 * re-emits them as `transcriptionSegment`, `transcriptionStateChanged` and
 * `agentStateChanged`. `CaptionStore` below folds the segment stream into
 * what a caption UI renders, so every UI layer (React, React Native, a
 * plain DOM overlay) applies the interim/final rules the same way.
 */

/** Identity prefix of an AI voice agent the platform put in the room (§1). */
export const AGENT_IDENTITY_PREFIX = 'agent-';
/** Identity prefix of the platform's transcriber (§1). It subscribes audio only and publishes nothing. */
export const TRANSCRIBER_IDENTITY_PREFIX = 'transcriber-';

export function isAgentIdentity(identity: string): boolean {
  return identity.startsWith(AGENT_IDENTITY_PREFIX);
}

export function isTranscriberIdentity(identity: string): boolean {
  return identity.startsWith(TRANSCRIBER_IDENTITY_PREFIX);
}

/**
 * One caption segment (§4.1).
 *
 * Interim segments share a `segmentId` and replace each other; the `final`
 * one closes it. A final with `text: ""` means the provider withdrew the
 * interim: clear it and show nothing.
 */
export interface TranscriptionSegment {
  type: 'transcription.segment';
  /** The transcription this belongs to. `null` for an agent's own speech while no transcription runs. */
  transcriptionId: string | null;
  /** Set when the segment is an AI agent's own speech. */
  agentId?: string;
  /** Who was speaking: a participant identity, or the agent's identity. */
  participantId: string;
  segmentId: string;
  text: string;
  final: boolean;
  language: string;
  /** Relative to the transcription's start. */
  startMs: number;
  endMs: number;
}

export type TranscriptionStatus = 'STARTING' | 'ACTIVE' | 'STOPPING' | 'ENDED' | 'FAILED';

/** The room's transcription changed status (§4.3). */
export interface TranscriptionState {
  transcriptionId: string;
  status: TranscriptionStatus;
  language: string;
}

/** What an AI voice agent is doing (§4.2). */
export type AgentState = 'listening' | 'thinking' | 'speaking' | 'ended';

const AGENT_STATES: ReadonlySet<string> = new Set(['listening', 'thinking', 'speaking', 'ended']);
const TRANSCRIPTION_STATUSES: ReadonlySet<string> = new Set(['STARTING', 'ACTIVE', 'STOPPING', 'ENDED', 'FAILED']);

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** @internal Shape-checks a `transcription.segment` frame; `undefined` when malformed. */
export function parseTranscriptionSegment(raw: Record<string, unknown>): TranscriptionSegment | undefined {
  if (!isStr(raw.participantId) || !isStr(raw.segmentId) || !isStr(raw.text) || typeof raw.final !== 'boolean') {
    return undefined;
  }
  return {
    type: 'transcription.segment',
    transcriptionId: isStr(raw.transcriptionId) ? raw.transcriptionId : null,
    ...(isStr(raw.agentId) ? { agentId: raw.agentId } : {}),
    participantId: raw.participantId,
    segmentId: raw.segmentId,
    text: raw.text,
    final: raw.final,
    language: isStr(raw.language) ? raw.language : '',
    startMs: isNum(raw.startMs) ? raw.startMs : 0,
    endMs: isNum(raw.endMs) ? raw.endMs : 0,
  };
}

/** @internal Shape-checks a `transcription.state` frame. */
export function parseTranscriptionState(raw: Record<string, unknown>): TranscriptionState | undefined {
  if (!isStr(raw.transcriptionId) || !isStr(raw.status) || !TRANSCRIPTION_STATUSES.has(raw.status)) {
    return undefined;
  }
  return {
    transcriptionId: raw.transcriptionId,
    status: raw.status as TranscriptionStatus,
    language: isStr(raw.language) ? raw.language : '',
  };
}

/** @internal An `agent.state` value, or `undefined` for one this SDK does not know. */
export function parseAgentState(value: unknown): AgentState | undefined {
  return isStr(value) && AGENT_STATES.has(value) ? (value as AgentState) : undefined;
}

/** What a caption UI renders, as of one moment. Immutable: a change produces a new snapshot. */
export interface CaptionSnapshot {
  /** Final segments, oldest first, at most `maxSegments` of them. Empty finals never appear. */
  segments: readonly TranscriptionSegment[];
  /** The open interim segment per speaker (`participantId`), if they are mid-sentence. */
  interim: Readonly<Record<string, TranscriptionSegment>>;
  /** Whether a transcription is running in the room (STARTING or ACTIVE), as far as this client has seen. */
  active: boolean;
  /** The latest `transcription.state`, if one has arrived. */
  state?: TranscriptionState;
}

export interface CaptionStoreOptions {
  /** How many final segments to keep. Default 100. */
  maxSegments?: number;
  /** Keep only this speaker's segments (a participant identity). */
  participantId?: string;
}

/** The room events a `CaptionStore` listens to. Structural, so a test double or LiveStream works too. */
export interface CaptionSource {
  on(event: 'transcriptionSegment', handler: (segment: TranscriptionSegment) => void): unknown;
  on(event: 'transcriptionStateChanged', handler: (state: TranscriptionState) => void): unknown;
  off?(event: 'transcriptionSegment', handler: (segment: TranscriptionSegment) => void): unknown;
  off?(event: 'transcriptionStateChanged', handler: (state: TranscriptionState) => void): unknown;
}

const EMPTY_SNAPSHOT: CaptionSnapshot = Object.freeze({ segments: [], interim: {}, active: false });

/**
 * Folds the caption stream into renderable state (§4.1).
 *
 * - An interim replaces the previous interim with the same `segmentId`.
 * - A final closes its `segmentId`: the interim goes, the final joins
 *   `segments` (bounded to `maxSegments`).
 * - A final with empty text just clears the interim.
 *
 * Framework-free and subscribable in the `useSyncExternalStore` shape:
 * `subscribe(listener)` plus `getSnapshot()`, which returns the same object
 * until something changes.
 *
 * ```ts
 * const captions = new CaptionStore();
 * const detach = captions.attach(room);
 * captions.subscribe(() => render(captions.getSnapshot()));
 * ```
 */
export class CaptionStore {
  private readonly maxSegments: number;
  private readonly participantId?: string;
  private snapshot: CaptionSnapshot = EMPTY_SNAPSHOT;
  /** Open interims by segmentId, in arrival order of their first update. */
  private open = new Map<string, TranscriptionSegment>();
  private listeners = new Set<() => void>();

  constructor(options: CaptionStoreOptions = {}) {
    this.maxSegments = Math.max(1, Math.floor(options.maxSegments ?? 100));
    this.participantId = options.participantId;
  }

  getSnapshot = (): CaptionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Listens to a room's caption events. Returns the detach function. */
  attach(source: CaptionSource): () => void {
    const onSegment = (segment: TranscriptionSegment) => this.applySegment(segment);
    const onState = (state: TranscriptionState) => this.applyState(state);
    const offSegment = source.on('transcriptionSegment', onSegment);
    const offState = source.on('transcriptionStateChanged', onState);
    return () => {
      // Room.on returns the room; LiveStream.on returns an unsubscribe.
      if (typeof offSegment === 'function') (offSegment as () => void)();
      else source.off?.('transcriptionSegment', onSegment);
      if (typeof offState === 'function') (offState as () => void)();
      else source.off?.('transcriptionStateChanged', onState);
    };
  }

  /** Applies one segment. Returns whether the snapshot changed. */
  applySegment(segment: TranscriptionSegment): boolean {
    if (this.participantId !== undefined && segment.participantId !== this.participantId) {
      return false;
    }
    let segments = this.snapshot.segments;
    if (segment.final) {
      const hadInterim = this.open.delete(segment.segmentId);
      if (segment.text.trim() === '') {
        if (!hadInterim) return false;
      } else {
        segments = [...segments, segment];
        if (segments.length > this.maxSegments) segments = segments.slice(segments.length - this.maxSegments);
      }
    } else {
      this.open.set(segment.segmentId, segment);
    }
    // A segment of a real transcription is proof one is running, even if
    // this client joined after its `transcription.state` went by.
    const active =
      segment.transcriptionId !== null && !this.snapshot.active && !isEnded(this.snapshot.state)
        ? true
        : this.snapshot.active;
    this.publish({ ...this.snapshot, segments, interim: this.buildInterim(), active });
    return true;
  }

  /** Applies a `transcription.state`. An ended or failed transcription drops any interim left open. */
  applyState(state: TranscriptionState): boolean {
    const active = state.status === 'STARTING' || state.status === 'ACTIVE';
    let interim = this.snapshot.interim;
    if (isEnded(state)) {
      // Agent speech (transcriptionId null) is not this transcription's to close.
      for (const [id, seg] of this.open) {
        if (seg.transcriptionId !== null) this.open.delete(id);
      }
      interim = this.buildInterim();
    }
    this.publish({ ...this.snapshot, interim, active, state });
    return true;
  }

  /** Forgets every segment (finals and interims). The transcription state is kept. */
  clear(): void {
    this.open.clear();
    this.publish({ ...this.snapshot, segments: [], interim: {} });
  }

  private buildInterim(): Record<string, TranscriptionSegment> {
    const interim: Record<string, TranscriptionSegment> = {};
    // Later entries win, so a speaker with two open segments shows the newer.
    for (const seg of this.open.values()) interim[seg.participantId] = seg;
    return interim;
  }

  private publish(next: CaptionSnapshot): void {
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) listener();
  }
}

function isEnded(state: TranscriptionState | undefined): boolean {
  return state?.status === 'ENDED' || state?.status === 'FAILED' || state?.status === 'STOPPING';
}
