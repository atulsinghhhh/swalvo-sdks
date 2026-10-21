import { RTCError } from './errors';
import { TypedEventEmitter } from './events';
import type { ConnectionQuality } from './internal/sfu/types';
import type { LocalTrack, RemoteTrack } from './track';
import { isAgentIdentity, isTranscriberIdentity, type AgentState } from './transcription';

/**
 * Events a single participant emits. Room-level events carry the same
 * information for everyone at once; these are for a component that only
 * cares about one person, so it need not filter the whole room's traffic.
 */
export interface ParticipantEventMap {
  /** This participant started or stopped speaking, by the SFU's measure. */
  isSpeakingChanged: (speaking: boolean) => void;
  /** The SFU's connection-quality score for this participant changed. */
  connectionQualityChanged: (quality: ConnectionQuality) => void;
  /** Phase 7: `metadata` or `attributes` changed. `prev` holds the values from before. */
  metadataChanged: (prev: ParticipantMetadataSnapshot) => void;
  /** Phase 6: this participant is an AI agent and its state changed. */
  agentStateChanged: (state: AgentState) => void;
}

/** A participant's metadata and attributes at one moment (phase7-contracts §2). */
export interface ParticipantMetadataSnapshot {
  metadata?: string;
  attributes: Record<string, string>;
}

/** Limits the server enforces on metadata and attributes (phase7-contracts §2). */
export const MAX_METADATA_BYTES = 4096;
export const MAX_ATTRIBUTES = 32;
export const MAX_ATTRIBUTE_KEY_LENGTH = 64;
export const MAX_ATTRIBUTE_VALUE_BYTES = 1024;

/** Fields the local user and remote participants have in common. */
export abstract class Participant extends TypedEventEmitter<ParticipantEventMap> {
  private _identity: string;
  private _isSpeaking = false;
  private _audioLevel = 0;
  private _connectionQuality: ConnectionQuality = 'unknown';
  private _metadata?: string;
  private _attributes: Record<string, string> = {};
  private _agentState?: AgentState;

  constructor(identity: string, metadata?: string, attributes?: Record<string, string>) {
    super();
    this._identity = identity;
    this._metadata = metadata;
    this._attributes = { ...(attributes ?? {}) };
  }

  /**
   * Opaque application metadata (at most 4 KiB). Starts from the RTC
   * token's `metadata` and changes live: see `metadataChanged` and the
   * room's `participantMetadataChanged`.
   */
  get metadata(): string | undefined {
    return this._metadata;
  }

  /** Key/value attributes (at most 32 keys). A copy: mutating it changes nothing. */
  get attributes(): Record<string, string> {
    return { ...this._attributes };
  }

  /**
   * @internal Applied by the adapter from `room.joined`,
   * `participant.joined` and `participant.updated`. Fields left
   * `undefined` are kept. Returns the previous values when anything
   * changed, and emits `metadataChanged`; otherwise `undefined`.
   */
  _applyMetadata(update: {
    metadata?: string | null;
    attributes?: Record<string, string> | null;
  }): ParticipantMetadataSnapshot | undefined {
    const prev: ParticipantMetadataSnapshot = { metadata: this._metadata, attributes: { ...this._attributes } };
    let changed = false;
    if (update.metadata !== undefined) {
      const next = update.metadata ?? undefined;
      if (next !== this._metadata) {
        this._metadata = next;
        changed = true;
      }
    }
    if (update.attributes !== undefined) {
      const next = sanitizeAttributes(update.attributes);
      if (!sameAttributes(next, this._attributes)) {
        this._attributes = next;
        changed = true;
      }
    }
    if (!changed) {
      return undefined;
    }
    this.emit('metadataChanged', prev);
    return prev;
  }

  /** The RTC token's participant identity. Stable for the whole session. */
  get identity(): string {
    return this._identity;
  }

  /** Whether this is an AI voice agent the platform put in the room (identity `agent-…`). */
  get isAgent(): boolean {
    return isAgentIdentity(this._identity);
  }

  /** Whether this is the platform's transcriber (identity `transcriber-…`). It publishes nothing. */
  get isTranscriber(): boolean {
    return isTranscriberIdentity(this._identity);
  }

  /**
   * An agent's latest state from `agent.state`, or `undefined` before the
   * first one (and always for a participant that is not an agent).
   */
  get agentState(): AgentState | undefined {
    return this._agentState;
  }

  /** @internal Applied by the adapter from `agent.state`. Returns whether it changed. */
  _setAgentState(state: AgentState): boolean {
    if (this._agentState === state) {
      return false;
    }
    this._agentState = state;
    this.emit('agentStateChanged', state);
    return true;
  }

  /**
   * Whether the SFU currently counts this participant as an active
   * speaker. Measured server-side from the audio they publish (RFC 6464
   * levels), so it is the same answer for everyone in the room. Always
   * false against a server that predates active-speaker detection.
   */
  get isSpeaking(): boolean {
    return this._isSpeaking;
  }

  /**
   * Smoothed audio level, 0..1, as of the last speaker update. Only
   * updated while the participant is among the active speakers; anyone
   * else reads 0. It is not a VU meter: updates arrive at most every
   * 300 ms, when the speaker set changes.
   */
  get audioLevel(): number {
    return this._audioLevel;
  }

  /**
   * The SFU's score for this participant's connection: loss, jitter and
   * RTT on what they send, and for a subscriber the bandwidth estimate
   * against what their subscriptions need. `'unknown'` until the server
   * has scored them, and always against a server that does not score.
   */
  get connectionQuality(): ConnectionQuality {
    return this._connectionQuality;
  }

  /**
   * @internal Called once by the SFU adapter just after connect() resolves.
   * The constructor runs before the server has confirmed identity, so this
   * patches it in afterwards.
   */
  _setIdentity(identity: string): void {
    this._identity = identity;
  }

  /** @internal Applied by the adapter from `speakers.changed`. Returns whether `isSpeaking` flipped. */
  _setSpeaking(speaking: boolean, level: number): boolean {
    this._audioLevel = speaking ? clampLevel(level) : 0;
    if (this._isSpeaking === speaking) {
      return false;
    }
    this._isSpeaking = speaking;
    this.emit('isSpeakingChanged', speaking);
    return true;
  }

  /** @internal Applied by the adapter from `quality.changed`. Returns whether it changed. */
  _setConnectionQuality(quality: ConnectionQuality): boolean {
    if (this._connectionQuality === quality) {
      return false;
    }
    this._connectionQuality = quality;
    this.emit('connectionQualityChanged', quality);
    return true;
  }
}

function sanitizeAttributes(raw: Record<string, string> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function sameAttributes(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}

/** @internal How a `LocalParticipant` reaches the connection to send `participant.update`. */
export interface LocalParticipantUpdater {
  /** Whether the token (or the server, live) grants `updateOwnMetadata`. */
  canUpdateMetadata(): boolean;
  sendUpdate(update: { metadata?: string; attributes?: Record<string, string> }): void;
}

export class LocalParticipant extends Participant {
  /** Tracks this participant has published, in publish order. Mutated by Room. */
  readonly tracks: LocalTrack[] = [];
  private updater?: LocalParticipantUpdater;

  /** @internal Wired by the SFU adapter. */
  _setUpdater(updater: LocalParticipantUpdater): void {
    this.updater = updater;
  }

  /**
   * Replaces this participant's metadata for everyone in the room
   * (phase7-contracts §2). Needs the token grant `updateOwnMetadata`;
   * throws `PERMISSION_DENIED` without it, and `INVALID_ARGUMENT` over
   * 4 KiB. `metadata` updates when the server echoes the change
   * (`metadataChanged`), not optimistically.
   */
  async setMetadata(metadata: string): Promise<void> {
    if (typeof metadata !== 'string') {
      throw new RTCError('INVALID_ARGUMENT', 'metadata must be a string');
    }
    if (utf8Length(metadata) > MAX_METADATA_BYTES) {
      throw new RTCError('INVALID_ARGUMENT', `metadata is over the ${MAX_METADATA_BYTES}-byte limit`);
    }
    this.requireUpdater().sendUpdate({ metadata });
  }

  /**
   * Sets attributes for everyone in the room. Merged by the server: keys
   * given here are replaced, others kept. Same grant and echo rules as
   * `setMetadata()`. Limits: 32 keys, 64-character keys, 1 KiB values.
   */
  async setAttributes(attributes: Record<string, string>): Promise<void> {
    if (!attributes || typeof attributes !== 'object') {
      throw new RTCError('INVALID_ARGUMENT', 'attributes must be an object of strings');
    }
    const entries = Object.entries(attributes);
    if (entries.length > MAX_ATTRIBUTES) {
      throw new RTCError('INVALID_ARGUMENT', `At most ${MAX_ATTRIBUTES} attributes are allowed`);
    }
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
        throw new RTCError('INVALID_ARGUMENT', `Attribute keys must be 1-${MAX_ATTRIBUTE_KEY_LENGTH} characters`);
      }
      if (typeof value !== 'string') {
        throw new RTCError('INVALID_ARGUMENT', `Attribute "${key}" must be a string`);
      }
      if (utf8Length(value) > MAX_ATTRIBUTE_VALUE_BYTES) {
        throw new RTCError(
          'INVALID_ARGUMENT',
          `Attribute "${key}" is over the ${MAX_ATTRIBUTE_VALUE_BYTES}-byte limit`,
        );
      }
    }
    this.requireUpdater().sendUpdate({ attributes: { ...attributes } });
  }

  private requireUpdater(): LocalParticipantUpdater {
    const updater = this.updater;
    if (!updater) {
      throw new RTCError('CONNECTION_FAILED', 'Not connected to a room');
    }
    if (!updater.canUpdateMetadata()) {
      throw new RTCError(
        'PERMISSION_DENIED',
        'The token does not grant updateOwnMetadata; mint it with perms.updateOwnMetadata: true',
      );
    }
    return updater;
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class RemoteParticipant extends Participant {
  /** Tracks subscribed from this participant, in subscribe order. Mutated by Room. */
  readonly tracks: RemoteTrack[] = [];
}
