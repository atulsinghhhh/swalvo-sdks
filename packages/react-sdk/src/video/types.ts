import type { Participant, Track, TrackKind } from '@swalvo/rtc';

/** A track source the video UI kit renders. `'unknown'` tracks are skipped. */
export type TrackSource = Exclude<TrackKind, 'unknown'>;

/**
 * One tile's worth of media: a participant plus the source it shows.
 *
 * `track` is `undefined` for a placeholder: a participant with their camera
 * off (so the grid still shows them), or a track they published that you
 * have not subscribed to yet.
 */
export interface TrackReference {
  participant: Participant;
  source: TrackSource;
  track?: Track;
  /** True for `room.localParticipant`. */
  isLocal: boolean;
}

/** A source, optionally with a placeholder for participants not publishing it. */
export interface TrackSourceWithOptions {
  source: TrackSource;
  /** Emit a `track: undefined` reference for participants without this source. Default false. */
  withPlaceholder?: boolean;
}

/**
 * What a user chose on `<PreJoin>`: their name, which devices to start
 * with, and whether each starts on. Pass it to `<VideoConference
 * userChoices>` to publish accordingly once joined.
 */
export interface LocalUserChoices {
  username: string;
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoDeviceId?: string;
  audioDeviceId?: string;
}

/** A stable key for a reference: `identity:source`. Use it as a React `key`. */
export function trackReferenceKey(ref: Pick<TrackReference, 'participant' | 'source'>): string {
  return `${ref.participant.identity}:${ref.source}`;
}

export function isSameTrackReference(a: TrackReference | undefined, b: TrackReference | undefined): boolean {
  if (!a || !b) return false;
  return a.participant === b.participant && a.source === b.source;
}

/**
 * A participant's display name: `name` or `displayName` from JSON
 * metadata when the token carried one, otherwise the identity.
 */
export function participantDisplayName(participant: Pick<Participant, 'identity' | 'metadata'>): string {
  const metadata = participant.metadata;
  if (typeof metadata === 'string' && metadata.startsWith('{')) {
    try {
      const parsed = JSON.parse(metadata) as { name?: unknown; displayName?: unknown };
      const name = parsed.name ?? parsed.displayName;
      if (typeof name === 'string' && name.trim()) return name.trim();
    } catch {
      // Not JSON after all; fall through to the identity.
    }
  }
  return participant.identity;
}

/** Up to two initials, for the avatar placeholder. */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._@-]+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const second = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + second).toUpperCase();
}
