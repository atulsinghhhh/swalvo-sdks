'use client';

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type HTMLAttributes } from 'react';
import type { AgentState, Participant, Room, TranscriptionSegment } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { useAgentState, useOptionalRoom, useTranscription } from '../hooks';
import { CaptionsIcon } from './icons';
import { participantDisplayName } from './types';
import { useAudioLevel, useParticipantTrack } from './video-hooks';

/** Finds a participant by identity in `room`, the local participant included. */
function findParticipant(room: Room | undefined, identity: string): Participant | undefined {
  if (!room) return undefined;
  if (room.localParticipant?.identity === identity) return room.localParticipant;
  const remotes = (room as { remoteParticipants?: Iterable<Participant> }).remoteParticipants;
  for (const p of remotes ?? []) if (p.identity === identity) return p;
  return undefined;
}

function speakerName(room: Room | undefined, identity: string): string {
  const participant = findParticipant(room, identity);
  return participant ? participantDisplayName(participant) : identity;
}

export interface CaptionsProps extends HTMLAttributes<HTMLDivElement> {
  /** Only this speaker's captions. Default: everyone, agents included. */
  participant?: Participant;
  /** At most this many lines on screen, newest last. Default 3. */
  maxLines?: number;
  /** A final line fades out this long after it arrived. Default 6000 ms. */
  fadeAfterMs?: number;
  /** Prefix each line with the speaker's name. Default true. */
  showSpeaker?: boolean;
  room?: Room;
}

/**
 * A live caption overlay (docs: /ai/transcription). Each speaker's interim
 * text shows in italics and is replaced as it firms up; the final line
 * replaces it and fades after `fadeAfterMs`. Renders nothing visible while
 * there is nothing to say, but stays mounted as an `aria-live="polite"`
 * region so screen readers announce final lines (interim text is hidden
 * from them, so it is not read out word by word).
 *
 * Captions come from a transcription started server-side
 * (`POST /v1/rooms/:roomId/transcription`) and from AI agents' speech.
 *
 * Classes: `swalvo-captions`, `swalvo-captions__line` (`data-interim` or
 * `data-final`), `swalvo-captions__speaker`, `swalvo-captions__text`.
 */
export function Captions({
  participant,
  maxLines = 3,
  fadeAfterMs = 6000,
  showSpeaker = true,
  room: explicitRoom,
  className,
  ...rest
}: CaptionsProps) {
  const contextRoom = useOptionalRoom();
  const room = explicitRoom ?? contextRoom;
  const { segments, interim } = useTranscription({ room, participant, maxSegments: Math.max(maxLines, 20) });

  // When each final first reached this component: fading is local time,
  // not the provider's clock.
  const arrivals = useRef(new Map<string, number>());
  const now = Date.now();
  for (const s of segments) {
    const key = finalKey(s);
    if (!arrivals.current.has(key)) arrivals.current.set(key, now);
  }
  const live = new Set(segments.map(finalKey));
  for (const key of arrivals.current.keys()) if (!live.has(key)) arrivals.current.delete(key);

  const visibleFinals = segments.filter((s) => (arrivals.current.get(finalKey(s)) ?? now) + fadeAfterMs > now);
  const lines: { segment: TranscriptionSegment; remaining?: number }[] = [
    ...visibleFinals.map((segment) => ({
      segment,
      remaining: (arrivals.current.get(finalKey(segment)) ?? now) + fadeAfterMs - now,
    })),
    ...Object.values(interim).map((segment) => ({ segment })),
  ].slice(-Math.max(1, maxLines));

  // Re-render when the oldest visible final is due to go.
  const [, setTick] = useState(0);
  const nextExpiry = visibleFinals.length
    ? Math.min(...visibleFinals.map((s) => (arrivals.current.get(finalKey(s)) ?? now) + fadeAfterMs))
    : undefined;
  useEffect(() => {
    if (nextExpiry === undefined) return undefined;
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(0, nextExpiry - Date.now()) + 16);
    return () => clearTimeout(timer);
  }, [nextExpiry]);

  return (
    <div
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Captions"
      {...rest}
      className={cx('swalvo-captions', className)}
      data-empty={lines.length === 0 || undefined}
    >
      {lines.map(({ segment, remaining }) => (
        <p
          key={`${segment.final ? 'f' : 'i'}:${finalKey(segment)}`}
          className="swalvo-captions__line"
          data-final={segment.final || undefined}
          data-interim={!segment.final || undefined}
          data-participant={segment.participantId}
          aria-hidden={segment.final ? undefined : true}
          style={
            remaining !== undefined
              ? ({ '--swalvo-caption-remaining': `${Math.max(0, remaining)}ms` } as CSSProperties)
              : undefined
          }
        >
          {showSpeaker && (
            <span className="swalvo-captions__speaker">{speakerName(room, segment.participantId)}: </span>
          )}
          <span className="swalvo-captions__text">{segment.text}</span>
        </p>
      ))}
    </div>
  );
}

function finalKey(segment: TranscriptionSegment): string {
  return `${segment.participantId}:${segment.segmentId}`;
}

export interface CaptionsToggleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  showLabel?: boolean;
}

/** A CC button for a control bar. `<VideoConference captions>` renders one. */
export function CaptionsToggle({
  enabled,
  onEnabledChange,
  showLabel = true,
  className,
  children,
  ...rest
}: CaptionsToggleProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx('swalvo-button', 'swalvo-captions-toggle', className)}
      data-enabled={enabled || undefined}
      aria-pressed={enabled}
      aria-label={showLabel ? undefined : 'Captions'}
      onClick={() => onEnabledChange(!enabled)}
    >
      <CaptionsIcon />
      {showLabel && <span className="swalvo-button__label">{children ?? 'Captions'}</span>}
    </button>
  );
}

const AGENT_STATE_LABELS: Record<AgentState, string> = {
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  ended: 'Ended',
};

/** Relative bar heights, so a level of 1 draws a rounded peak rather than a flat block. */
const BAR_WEIGHTS = [0.55, 0.8, 1, 0.8, 0.55, 0.7, 0.9];

export interface AgentVisualizerProps extends HTMLAttributes<HTMLDivElement> {
  /** The agent (`participant.isAgent`). */
  participant: Participant | undefined;
  /** How many level bars to draw. Default 5. */
  barCount?: number;
  /** Show the state as text under the ring. Default true. */
  showLabel?: boolean;
  room?: Room;
}

/**
 * An AI voice agent at a glance (docs: /ai/agents): a ring that changes
 * with the agent's state (`data-state`: `listening`, `thinking`,
 * `speaking`, `ended`) and level bars driven by the agent's audio while it
 * speaks. Announces state changes politely to screen readers.
 *
 * Classes: `swalvo-agent-visualizer`, `__ring`, `__bars`, `__bar`, `__label`.
 * The bar height is `--swalvo-agent-level` (0..1) on each bar.
 */
export function AgentVisualizer({
  participant,
  barCount = 5,
  showLabel = true,
  room: explicitRoom,
  className,
  ...rest
}: AgentVisualizerProps) {
  const contextRoom = useOptionalRoom();
  const room = explicitRoom ?? contextRoom;
  const state = useAgentState(participant);
  const mic = useParticipantTrack(participant, 'microphone', room);
  const level = useAudioLevel(state === 'ended' ? undefined : mic?.mediaStreamTrack);
  const shown = state === 'speaking' ? level : 0;
  const count = Math.max(1, Math.min(BAR_WEIGHTS.length, Math.floor(barCount)));
  const weights = BAR_WEIGHTS.slice(Math.floor((BAR_WEIGHTS.length - count) / 2)).slice(0, count);
  const name = participant ? participantDisplayName(participant) : 'Agent';
  const label = state ? AGENT_STATE_LABELS[state] : 'Connecting';

  return (
    <div
      role="status"
      aria-live="polite"
      {...rest}
      className={cx('swalvo-agent-visualizer', className)}
      data-state={state ?? 'connecting'}
      data-participant={participant?.identity}
    >
      <div className="swalvo-agent-visualizer__ring" aria-hidden="true">
        <div className="swalvo-agent-visualizer__bars">
          {weights.map((weight, i) => (
            <span
              key={i}
              className="swalvo-agent-visualizer__bar"
              style={{ '--swalvo-agent-level': String(Math.min(1, shown * weight)) } as CSSProperties}
            />
          ))}
        </div>
      </div>
      {showLabel ? (
        <span className="swalvo-agent-visualizer__label">
          <span className="swalvo-agent-visualizer__name">{name}</span> · {label}
        </span>
      ) : (
        <span className="swalvo-visually-hidden">{`${name}: ${label}`}</span>
      )}
    </div>
  );
}
