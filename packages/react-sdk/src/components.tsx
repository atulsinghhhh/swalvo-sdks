'use client';

import { useEffect, useRef } from 'react';
import type { LocalParticipant, RemoteParticipant, Track } from '@swalvo/rtc';
import { useConnectionQuality, useIsSpeaking, useLocalParticipant } from './hooks';

/**
 * Optional primitives (Phase 11 spec §18/§19). Every hook above works
 * perfectly well without them; use these for a quick start, not because
 * you have to.
 *
 * Attaches and detaches a track to a real `<video>` or `<audio>` element
 * through `Track.attach()` and `.detach()`. Never touches SDP or track
 * internals itself.
 */
export interface SwalvoVideoProps extends Omit<React.VideoHTMLAttributes<HTMLVideoElement>, 'ref'> {
  track?: Track;
}

export function SwalvoVideo({ track, ...props }: SwalvoVideoProps) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!track || !element) return undefined;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return <video ref={ref} autoPlay playsInline {...props} />;
}

export interface SwalvoAudioProps extends Omit<React.AudioHTMLAttributes<HTMLAudioElement>, 'ref'> {
  track?: Track;
}

export function SwalvoAudio({ track, ...props }: SwalvoAudioProps) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!track || !element) return undefined;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return <audio ref={ref} autoPlay {...props} />;
}

export interface ParticipantViewProps {
  participant: LocalParticipant | RemoteParticipant;
  className?: string;
  /** Rendered below the video and audio elements. Defaults to the participant's identity. */
  label?: React.ReactNode;
  /** Added to `className` while the participant is speaking, for a highlight ring. */
  speakingClassName?: string;
  /**
   * Renders a small connection-quality indicator next to the label
   * (`<span data-swalvo-connection-quality="good">`), unstyled. Off by
   * default. The score is on the tile as `data-swalvo-connection-quality`
   * either way, for CSS.
   */
  showConnectionQuality?: boolean;
}

const QUALITY_LABELS: Record<string, string> = {
  excellent: 'Excellent connection',
  good: 'Good connection',
  poor: 'Poor connection',
  lost: 'Connection lost',
  unknown: 'Connection quality unknown',
};

/**
 * A ready-made tile: video (camera or screen share), audio, an identity
 * label. Entirely optional. If it doesn't fit, build your own from
 * `useParticipants()` plus `SwalvoVideo`/`SwalvoAudio`.
 *
 * Headless about styling: speaking and connection quality are exposed as
 * `data-swalvo-speaking` and `data-swalvo-connection-quality` attributes on
 * the tile, so a stylesheet can react to them without any props at all.
 */
export function ParticipantView({
  participant,
  className,
  label,
  speakingClassName,
  showConnectionQuality = false,
}: ParticipantViewProps) {
  const videoTrack = participant.tracks.find((t) => t.kind === 'camera' || t.kind === 'screenShare');
  const audioTrack = participant.tracks.find((t) => t.kind === 'microphone');
  const speaking = useIsSpeaking(participant);
  const quality = useConnectionQuality(participant);
  const classes = [className, speaking ? speakingClassName : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <div
      className={classes}
      data-swalvo-participant={participant.identity}
      data-swalvo-speaking={speaking ? 'true' : 'false'}
      data-swalvo-connection-quality={quality}
    >
      {videoTrack ? (
        <SwalvoVideo track={videoTrack} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : null}
      {audioTrack ? <SwalvoAudio track={audioTrack} /> : null}
      <span data-swalvo-participant-label>{label ?? participant.identity}</span>
      {showConnectionQuality ? (
        <span data-swalvo-connection-quality={quality} role="img" aria-label={QUALITY_LABELS[quality] ?? quality} />
      ) : null}
    </div>
  );
}

export function LocalParticipantView({
  className,
  label,
  speakingClassName,
  showConnectionQuality,
}: {
  className?: string;
  label?: React.ReactNode;
  speakingClassName?: string;
  showConnectionQuality?: boolean;
}) {
  const local = useLocalParticipant();
  if (!local) return null;
  return (
    <ParticipantView
      participant={local}
      className={className}
      label={label}
      speakingClassName={speakingClassName}
      showConnectionQuality={showConnectionQuality}
    />
  );
}
