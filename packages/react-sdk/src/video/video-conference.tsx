'use client';

import { useEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { Room } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { useOptionalRoom } from '../hooks';
import { RoomAudioRenderer, StartAudio } from './audio';
import { Captions, CaptionsToggle, type CaptionsProps } from './captions';
import { ControlBar, type ControlBarControls } from './controls';
import { LayoutContextProvider, useLayoutContext } from './layout-context';
import { FocusLayout, GridLayout } from './layouts';
import type { ParticipantTileProps } from './participant-tile';
import { devicePreferencesFor } from './stores';
import { ConnectionStateToast } from './toast';
import { isSameTrackReference, type LocalUserChoices, type TrackReference } from './types';
import { useRoomConnectionState, useTracks, useTrackToggle } from './video-hooks';

export interface VideoConferenceProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /**
   * The chat side panel's content — typically the chat UI kit inside its
   * own provider. Adds a Chat button to the control bar.
   *
   * ```tsx
   * chat={<ChatProvider client={chat}><MessageList room={id} /><MessageComposer room={id} /></ChatProvider>}
   * ```
   */
  chat?: ReactNode;
  defaultChatOpen?: boolean;
  /** Called after leaving through the Leave button. */
  onLeave?: () => void;
  /** From `<PreJoin>`: start with camera/mic on or off, on the chosen devices. */
  userChoices?: Partial<LocalUserChoices>;
  /** Grid tiles per page before paginating. Default: by width. */
  maxTilesPerPage?: number;
  controls?: ControlBarControls;
  /** Props for every default tile. */
  tileProps?: Partial<ParticipantTileProps>;
  /** Replace the default tile. */
  renderTile?: (trackRef: TrackReference) => ReactNode;
  /** Force a color scheme for the default stylesheet. Default: follow the OS (dark first). */
  theme?: 'dark' | 'light';
  room?: Room;
  /**
   * Live captions (docs: /ai/transcription): adds a Captions button to the
   * control bar and a `<Captions>` overlay at the bottom of the stage.
   * `true` starts with captions on; pass `{ defaultEnabled: false }` to
   * start them off, plus any `<Captions>` props. Captions appear once a
   * transcription runs in the room (started from your backend).
   */
  captions?: boolean | (Omit<CaptionsProps, 'room'> & { defaultEnabled?: boolean });
  /** Rendered inside the stage, over the layout (badges, banners). */
  children?: ReactNode;
}

/**
 * A complete call screen in one component: a paginated grid that switches
 * to a focus layout for a screen share or a pinned tile, active-speaker
 * highlighting, a control bar with device menus, remote audio, an autoplay
 * unlock button, reconnection toasts, and an optional chat panel.
 *
 * ```tsx
 * import '@swalvo/react/video/styles.css';
 * <SwalvoRoom {...grant} room={roomName}><VideoConference onLeave={() => router.back()} /></SwalvoRoom>
 * ```
 *
 * Every piece is exported on its own for a custom arrangement.
 */
export function VideoConference({ chat, defaultChatOpen = false, ...rest }: VideoConferenceProps) {
  return (
    <LayoutContextProvider chatAvailable={chat !== undefined && chat !== null} defaultChatOpen={defaultChatOpen}>
      <VideoConferenceInner chat={chat} {...rest} />
    </LayoutContextProvider>
  );
}

function VideoConferenceInner({
  chat,
  onLeave,
  userChoices,
  maxTilesPerPage,
  controls,
  tileProps,
  renderTile,
  theme,
  room: explicitRoom,
  captions,
  className,
  children,
  ...rest
}: Omit<VideoConferenceProps, 'defaultChatOpen'>) {
  const contextRoom = useOptionalRoom();
  const room = explicitRoom ?? contextRoom;
  const layout = useLayoutContext();
  const tracks = useTracks(undefined, { room });
  usePublishUserChoices(room, userChoices);

  // A pin outlives its track only until the track goes away.
  const pinned = layout?.pinned;
  const unpin = layout?.unpin;
  const pinnedLive = pinned ? tracks.find((ref) => isSameTrackReference(ref, pinned)) : undefined;
  useEffect(() => {
    if (pinned && !pinnedLive) unpin?.();
  }, [pinned, pinnedLive, unpin]);

  // Focus: a pin wins, then the newest remote screen share.
  const focus = useMemo(() => {
    if (pinnedLive) return pinnedLive;
    const shares = tracks.filter((ref) => ref.source === 'screenShare' && ref.track && !ref.isLocal);
    return shares[shares.length - 1];
  }, [tracks, pinnedLive]);
  const others = useMemo(() => (focus ? tracks.filter((ref) => ref !== focus) : tracks), [tracks, focus]);
  const chatOpen = !!chat && !!layout?.chat.open;
  const { defaultEnabled: captionsDefault = true, ...captionsProps } =
    typeof captions === 'object' && captions !== null
      ? captions
      : ({} as Omit<CaptionsProps, 'room'> & { defaultEnabled?: boolean });
  const [captionsOn, setCaptionsOn] = useState(captionsDefault);

  return (
    <div
      {...rest}
      className={cx('swalvo-video', 'swalvo-video-conference', className)}
      data-theme={theme}
      data-layout={focus ? 'focus' : 'grid'}
      data-chat-open={chatOpen || undefined}
    >
      <div className="swalvo-video-conference__body">
        <section className="swalvo-video-conference__stage" aria-label="Participants">
          {focus ? (
            <FocusLayout trackRef={focus} others={others} renderTile={renderTile} tileProps={tileProps} room={room} />
          ) : (
            <GridLayout
              tracks={tracks}
              maxTilesPerPage={maxTilesPerPage}
              renderTile={renderTile}
              tileProps={tileProps}
              room={room}
            />
          )}
          <div className="swalvo-video-conference__overlays">
            <ConnectionStateToast />
            <StartAudio room={room} />
          </div>
          {captions && captionsOn && (
            <Captions
              {...captionsProps}
              room={room}
              className={cx('swalvo-video-conference__captions', captionsProps.className)}
            />
          )}
          {children}
        </section>
        {chat && (
          <aside className="swalvo-video-conference__chat" aria-label="Chat" hidden={!chatOpen}>
            {chat}
          </aside>
        )}
      </div>
      <ControlBar controls={controls} onLeave={onLeave} room={room}>
        {captions ? <CaptionsToggle enabled={captionsOn} onEnabledChange={setCaptionsOn} /> : null}
      </ControlBar>
      <RoomAudioRenderer room={room} />
    </div>
  );
}

/** Publishes the camera/mic once per room, as chosen on `<PreJoin>`. */
function usePublishUserChoices(room: Room | undefined, choices: Partial<LocalUserChoices> | undefined): void {
  const { state } = useRoomConnectionState();
  const camera = useTrackToggle('camera', { room });
  const microphone = useTrackToggle('microphone', { room });
  const done = useRef<Room | undefined>(undefined);
  const toggleCamera = camera.toggle;
  const toggleMicrophone = microphone.toggle;

  useEffect(() => {
    if (!room || !choices || done.current === room) return;
    if (state !== 'connected' && room.connectionState !== 'connected') return;
    done.current = room;
    const prefs = devicePreferencesFor(room);
    if (choices.videoDeviceId) prefs.set('videoinput', choices.videoDeviceId);
    if (choices.audioDeviceId) prefs.set('audioinput', choices.audioDeviceId);
    if (choices.videoEnabled) void toggleCamera(true);
    if (choices.audioEnabled) void toggleMicrophone(true);
  }, [room, choices, state, toggleCamera, toggleMicrophone]);
}
