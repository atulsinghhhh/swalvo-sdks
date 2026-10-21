'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import type { RemoteTrack, Room } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { SwalvoVideo } from '../components';
import { useE2EEState, useIsSpeaking, useOptionalRoom, useTrackSubscriptionState } from '../hooks';
import { ConnectionQualityIndicator } from './connection-quality-indicator';
import { LockIcon, MicOffIcon, PinIcon, WarningIcon } from './icons';
import { useLayoutContext, usePinnedTracks } from './layout-context';
import { initialsOf, participantDisplayName, type TrackReference } from './types';
import { useIsMuted, useParticipantTrack } from './video-hooks';

export interface ParticipantTileProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  trackRef: TrackReference;
  /** Overrides the name shown (default: JSON metadata `name`, else the identity). */
  name?: ReactNode;
  /** Show the connection-quality bars. Default true. */
  showConnectionQuality?: boolean;
  /** Show a pin/unpin button (needs a layout context, e.g. inside `<VideoConference>`). Default true. */
  showPinButton?: boolean;
  /** Mirror your own camera, as a mirror would. Default true. Never applied to screen shares. */
  mirrorLocalCamera?: boolean;
  /** Extra content rendered over the tile, e.g. a hand-raise badge. */
  children?: ReactNode;
  /** Use this room instead of the one from `<SwalvoRoom>`. */
  room?: Room;
}

/**
 * One participant's camera or screen share, or an initials avatar when the
 * video is off, with a name bar showing mic state, an E2EE badge and
 * connection quality.
 *
 * Renders no audio: put one `<RoomAudioRenderer>` on the page (as
 * `<VideoConference>` does) so audio keeps playing whichever tiles are on
 * screen.
 *
 * State is exposed as data attributes for styling: `data-speaking`,
 * `data-video-muted`, `data-audio-muted`, `data-local`, `data-source`,
 * `data-pinned`, `data-subscription` (`active` / `paused_bandwidth` /
 * `paused_client`) and `data-e2ee`.
 */
export function ParticipantTile({
  trackRef,
  name,
  showConnectionQuality = true,
  showPinButton = true,
  mirrorLocalCamera = true,
  children,
  room: explicitRoom,
  className,
  ...rest
}: ParticipantTileProps) {
  const contextRoom = useOptionalRoom();
  const room = explicitRoom ?? contextRoom;
  const { participant, source, track, isLocal } = trackRef;
  const videoMuted = useIsMuted(trackRef, room);
  const micTrack = useParticipantTrack(participant, 'microphone', room);
  const audioMuted = !micTrack || micTrack.isMuted === true;
  const speaking = useIsSpeaking(participant);
  const remoteVideo = !isLocal && track ? (track as RemoteTrack) : undefined;
  const subscription = useTrackSubscriptionState(remoteVideo, room);
  const e2ee = useE2EEState(participant, room);
  const encrypted =
    e2ee === 'ok' || (e2ee === undefined && (room as { isE2EEActive?: boolean } | undefined)?.isE2EEActive === true);
  const e2eeFailed = e2ee === 'missing_key' || e2ee === 'decrypt_failed' || e2ee === 'encrypt_failed';
  const layout = useLayoutContext();
  const { isPinned, pin, unpin } = usePinnedTracks();
  const pinned = isPinned(trackRef);

  const displayName = name ?? participantDisplayName(participant);
  const textName = typeof displayName === 'string' ? displayName : participant.identity;
  const isScreen = source === 'screenShare';
  const showVideo = !!track && !videoMuted;
  const mirrored = mirrorLocalCamera && isLocal && source === 'camera';
  const paused = subscription.state === 'paused_bandwidth';
  const tileLabel = `${textName}${isLocal ? ' (you)' : ''}${isScreen ? ', screen share' : ''}`;

  return (
    <div
      {...rest}
      className={cx('swalvo-participant-tile', className)}
      role="group"
      aria-label={tileLabel}
      data-participant={participant.identity}
      data-source={source}
      data-local={isLocal || undefined}
      data-speaking={(speaking && !isScreen) || undefined}
      data-video-muted={!showVideo || undefined}
      data-audio-muted={audioMuted || undefined}
      data-pinned={pinned || undefined}
      data-subscription={remoteVideo ? subscription.state : undefined}
      data-e2ee={e2ee ?? (encrypted ? 'ok' : undefined)}
    >
      {showVideo ? (
        <SwalvoVideo
          track={track}
          muted
          className="swalvo-participant-tile__video"
          data-mirrored={mirrored || undefined}
          data-fit={isScreen ? 'contain' : 'cover'}
          style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
        />
      ) : (
        <div className="swalvo-participant-tile__placeholder" aria-hidden="true">
          <span className="swalvo-avatar">{initialsOf(textName)}</span>
        </div>
      )}

      {paused && (
        <div className="swalvo-participant-tile__notice" role="status">
          Video paused to save bandwidth
        </div>
      )}

      <div className="swalvo-participant-tile__meta">
        {!isScreen && audioMuted && (
          <span
            className="swalvo-participant-tile__muted"
            role="img"
            aria-label="Microphone off"
            title="Microphone off"
          >
            <MicOffIcon width={14} height={14} />
          </span>
        )}
        <span className="swalvo-participant-tile__name">
          {displayName}
          {isLocal && <span className="swalvo-participant-tile__you"> (you)</span>}
          {isScreen && <span className="swalvo-participant-tile__source">, screen</span>}
        </span>
        {encrypted && !e2eeFailed && (
          <span
            className="swalvo-e2ee-badge"
            data-state="ok"
            role="img"
            aria-label="End-to-end encrypted"
            title="End-to-end encrypted"
          >
            <LockIcon width={14} height={14} />
          </span>
        )}
        {e2eeFailed && (
          <span
            className="swalvo-e2ee-badge"
            data-state={e2ee}
            role="img"
            aria-label={isLocal ? 'Encryption failed' : "Can't decrypt this participant's media"}
            title={isLocal ? 'Encryption failed' : "Can't decrypt — check the encryption key"}
          >
            <WarningIcon width={14} height={14} />
          </span>
        )}
        {showConnectionQuality && !isScreen && <ConnectionQualityIndicator participant={participant} />}
      </div>

      {showPinButton && layout && (
        <button
          type="button"
          className="swalvo-participant-tile__pin swalvo-button"
          data-variant="ghost"
          aria-pressed={pinned}
          aria-label={`Pin ${textName}`}
          onClick={() => (pinned ? unpin() : pin(trackRef))}
        >
          <PinIcon width={16} height={16} />
        </button>
      )}
      {children}
    </div>
  );
}
