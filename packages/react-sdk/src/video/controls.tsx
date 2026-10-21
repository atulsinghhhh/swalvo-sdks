'use client';

import type { ButtonHTMLAttributes, HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import type { DeviceKind, Room } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import {
  CameraIcon,
  CameraOffIcon,
  ChatIcon,
  LeaveIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareIcon,
  ScreenShareStopIcon,
} from './icons';
import { useChatToggle } from './layout-context';
import { MediaDeviceMenu } from './media-device-menu';
import { supportsScreenShare, useDisconnectButton, useTrackToggle, type ToggleSource } from './video-hooks';

const TOGGLE_LABELS: Record<ToggleSource, string> = {
  microphone: 'Microphone',
  camera: 'Camera',
  screenShare: 'Share screen',
};

function toggleIcon(source: ToggleSource, enabled: boolean) {
  if (source === 'microphone') return enabled ? <MicIcon /> : <MicOffIcon />;
  if (source === 'camera') return enabled ? <CameraIcon /> : <CameraOffIcon />;
  return enabled ? <ScreenShareStopIcon /> : <ScreenShareIcon />;
}

export interface TrackToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'onError'> {
  source: ToggleSource;
  /** Show the text label next to the icon. Default true. */
  showLabel?: boolean;
  room?: Room;
  onChange?: (enabled: boolean) => void;
  onError?: (error: Error) => void;
}

/**
 * A toggle button for your mic, camera or screen share. `aria-pressed`
 * reflects the state; while a toggle is in flight it is `aria-busy` and
 * `data-pending` (clicks are ignored rather than the button disabled, so
 * keyboard focus is never lost). A failure — permission denied, device
 * busy — sets `data-error` and the button's description.
 */
export function TrackToggle({
  source,
  showLabel = true,
  room,
  onChange,
  onError,
  className,
  children,
  ...rest
}: TrackToggleProps) {
  const { enabled, pending, error, toggle } = useTrackToggle(source, { room, onChange, onError });
  const label = TOGGLE_LABELS[source];
  return (
    <button
      type="button"
      {...rest}
      className={cx('swalvo-button', 'swalvo-track-toggle', className)}
      data-source={source}
      data-enabled={enabled || undefined}
      data-pending={pending || undefined}
      data-error={error ? true : undefined}
      aria-pressed={enabled}
      aria-busy={pending || undefined}
      aria-label={showLabel ? undefined : label}
      title={error ? `${label}: ${error.message}` : rest.title}
      onClick={() => {
        if (!pending) void toggle();
      }}
    >
      {toggleIcon(source, enabled)}
      {showLabel && <span className="swalvo-button__label">{children ?? label}</span>}
    </button>
  );
}

export interface DisconnectButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  onLeave?: () => void;
  showLabel?: boolean;
  room?: Room;
}

/** Leaves the room, then calls `onLeave`. */
export function DisconnectButton({
  onLeave,
  showLabel = true,
  room,
  className,
  children,
  ...rest
}: DisconnectButtonProps) {
  const { buttonProps } = useDisconnectButton({ onLeave, room });
  return (
    <button
      {...rest}
      {...buttonProps}
      className={cx('swalvo-button', 'swalvo-disconnect-button', className)}
      data-variant="danger"
      aria-label={showLabel ? undefined : 'Leave'}
    >
      <LeaveIcon />
      {showLabel && <span className="swalvo-button__label">{children ?? 'Leave'}</span>}
    </button>
  );
}

export interface ChatToggleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  showLabel?: boolean;
}

/** Opens and closes `<VideoConference>`'s chat panel. Renders nothing when there is no panel. */
export function ChatToggle({ showLabel = true, className, children, ...rest }: ChatToggleProps) {
  const chat = useChatToggle();
  if (!chat.available) return null;
  return (
    <button
      type="button"
      {...rest}
      className={cx('swalvo-button', 'swalvo-chat-toggle', className)}
      data-enabled={chat.open || undefined}
      aria-pressed={chat.open}
      aria-label={showLabel ? undefined : 'Chat'}
      onClick={chat.toggle}
    >
      <ChatIcon />
      {showLabel && <span className="swalvo-button__label">{children ?? 'Chat'}</span>}
    </button>
  );
}

export interface ControlBarControls {
  microphone?: boolean;
  camera?: boolean;
  /** Hidden automatically where the browser can't share a screen. */
  screenShare?: boolean;
  /** Shown only when a chat panel is available. */
  chat?: boolean;
  leave?: boolean;
}

export interface ControlBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Which controls to show. All default to true. */
  controls?: ControlBarControls;
  /** Device dropdowns next to the mic and camera. Default true. */
  showDeviceMenus?: boolean;
  /** `'verbose'` shows text labels, `'minimal'` icons only. Default: `'verbose'`. */
  variation?: 'verbose' | 'minimal';
  onLeave?: () => void;
  onDeviceError?: (error: Error, source: ToggleSource | DeviceKind) => void;
  room?: Room;
  /** Extra controls, appended before Leave. */
  children?: ReactNode;
}

/**
 * The call's toolbar: mic and camera toggles with device menus, screen
 * share, chat, leave. A `role="toolbar"`, so assistive tech announces it
 * as one control group.
 */
export function ControlBar({
  controls = {},
  showDeviceMenus = true,
  variation = 'verbose',
  onLeave,
  onDeviceError,
  room,
  className,
  children,
  onKeyDown,
  ...rest
}: ControlBarProps) {
  // Arrow keys move between the toolbar's buttons (Tab still works too).
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    const target = event.target as HTMLElement;
    if (target.closest('[role="menu"]')) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'),
    ).filter((button) => !button.closest('[role="menu"]'));
    const index = buttons.indexOf(target as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'ArrowRight' ? index + 1 : index - 1;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  const show = {
    microphone: controls.microphone ?? true,
    camera: controls.camera ?? true,
    screenShare: (controls.screenShare ?? true) && supportsScreenShare(),
    chat: controls.chat ?? true,
    leave: controls.leave ?? true,
  };
  const showLabel = variation === 'verbose';

  return (
    <div
      role="toolbar"
      aria-label="Call controls"
      {...rest}
      className={cx('swalvo-control-bar', className)}
      data-variation={variation}
      onKeyDown={handleKeyDown}
    >
      {show.microphone && (
        <div className="swalvo-button-group">
          <TrackToggle
            source="microphone"
            showLabel={showLabel}
            room={room}
            onError={(e) => onDeviceError?.(e, 'microphone')}
          />
          {showDeviceMenus && (
            <MediaDeviceMenu
              kinds={['audioinput', 'audiooutput']}
              room={room}
              onError={(e) => onDeviceError?.(e, 'audioinput')}
            />
          )}
        </div>
      )}
      {show.camera && (
        <div className="swalvo-button-group">
          <TrackToggle
            source="camera"
            showLabel={showLabel}
            room={room}
            onError={(e) => onDeviceError?.(e, 'camera')}
          />
          {showDeviceMenus && (
            <MediaDeviceMenu kind="videoinput" room={room} onError={(e) => onDeviceError?.(e, 'videoinput')} />
          )}
        </div>
      )}
      {show.screenShare && (
        <TrackToggle
          source="screenShare"
          showLabel={showLabel}
          room={room}
          onError={(e) => onDeviceError?.(e, 'screenShare')}
        />
      )}
      {show.chat && <ChatToggle showLabel={showLabel} />}
      {children}
      {show.leave && <DisconnectButton showLabel={showLabel} onLeave={onLeave} room={room} />}
    </div>
  );
}
