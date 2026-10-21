'use client';

import { useEffect, useRef, type ButtonHTMLAttributes } from 'react';
import type { Room, Track } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { useOptionalRoom } from '../hooks';
import { SpeakerIcon } from './icons';
import { audioPlaybackFor } from './stores';
import { trackReferenceKey, type TrackSource } from './types';
import { useAudioPlayback, useTracks } from './video-hooks';

const MIC_SOURCES: TrackSource[] = ['microphone'];

export interface RoomAudioRendererProps {
  /** 0–1, applied to every remote participant. Default 1. */
  volume?: number;
  /** Mute all remote audio locally (others are unaffected). */
  muted?: boolean;
  room?: Room;
}

/**
 * Plays every remote participant's microphone through hidden `<audio>`
 * elements — one per track, so audio never depends on which video tiles
 * are on screen. Render exactly one per call.
 *
 * Each element reports to the autoplay tracker, so if the browser blocks
 * playback `<StartAudio>` (or `useAudioPlayback()`) knows to ask for a
 * click.
 */
export function RoomAudioRenderer({ volume = 1, muted = false, room: explicitRoom }: RoomAudioRendererProps) {
  const contextRoom = useOptionalRoom();
  const room = explicitRoom ?? contextRoom;
  const tracks = useTracks(MIC_SOURCES, { room, onlySubscribed: true });
  return (
    <div className="swalvo-room-audio" hidden aria-hidden="true" style={{ display: 'none' }}>
      {tracks
        .filter((ref) => !ref.isLocal && ref.track)
        .map((ref) => (
          <RemoteAudio key={trackReferenceKey(ref)} track={ref.track!} room={room} volume={volume} muted={muted} />
        ))}
    </div>
  );
}

function RemoteAudio({ track, room, volume, muted }: { track: Track; room?: Room; volume: number; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    track.attach(element);
    const unregister = audioPlaybackFor(room).register(element);
    return () => {
      unregister();
      track.detach(element);
    };
  }, [track, room]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, volume));
    element.muted = muted;
  }, [volume, muted]);

  return <audio ref={ref} autoPlay />;
}

export interface StartAudioProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Button text. Default "Start audio". */
  label?: string;
  room?: Room;
}

/**
 * Appears only when the browser's autoplay policy blocked remote audio,
 * and unblocks it on click. Browsers allow playback after a user gesture
 * on the page, which this button is.
 */
export function StartAudio({ label = 'Start audio', room, className, children, ...rest }: StartAudioProps) {
  const { canPlayAudio, startAudio } = useAudioPlayback(room);
  if (canPlayAudio) return null;
  return (
    <button
      type="button"
      {...rest}
      className={cx('swalvo-button', 'swalvo-start-audio', className)}
      data-variant="primary"
      onClick={() => void startAudio()}
    >
      <SpeakerIcon />
      <span className="swalvo-button__label">{children ?? label}</span>
    </button>
  );
}
