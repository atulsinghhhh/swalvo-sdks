'use client';

import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import type { DisconnectReason } from '@swalvo/rtc';
import { cx } from '../chat/ui/cx';
import { useRoomConnectionState } from './video-hooks';

export interface ToastProps extends HTMLAttributes<HTMLDivElement> {
  /** `'error'` is announced assertively (`role="alert"`); the rest politely. */
  kind?: 'info' | 'success' | 'warning' | 'error';
  /** Show a spinner, for an in-progress state. */
  busy?: boolean;
  children?: ReactNode;
}

/** A small status message. Unstyled; the stylesheet floats it over the stage. */
export function Toast({ kind = 'info', busy = false, className, children, ...rest }: ToastProps) {
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      {...rest}
      className={cx('swalvo-toast', className)}
      data-kind={kind}
      data-busy={busy || undefined}
    >
      {busy && <span className="swalvo-spinner" aria-hidden="true" />}
      <span className="swalvo-toast__message">{children}</span>
    </div>
  );
}

export const DISCONNECT_REASON_MESSAGES: Record<DisconnectReason, string> = {
  CLIENT_INITIATED: 'You left the call',
  REMOVED: 'You were removed from the call',
  ROOM_CLOSED: 'The call has ended',
  TOKEN_EXPIRED: 'Your session expired',
  CONNECTION_FAILED: 'Lost connection to the call',
};

export interface ConnectionStateToastProps extends Omit<ToastProps, 'kind' | 'busy' | 'children'> {
  /** How long "Connection restored" stays up, ms. Default 3000. */
  resumedDurationMs?: number;
  /** Override the text for a state. */
  messages?: Partial<{
    reconnecting: string;
    resumed: string;
    failed: string;
    disconnected: (reason: DisconnectReason) => string;
  }>;
}

/**
 * Announces connection trouble: "Reconnecting…" while the SDK recovers,
 * "Connection restored" briefly after, and why the call ended when the
 * server ends it (removed, room closed, token expired). Leaving yourself
 * shows nothing.
 */
export function ConnectionStateToast({ resumedDurationMs = 3000, messages = {}, ...rest }: ConnectionStateToastProps) {
  const { state, disconnectReason } = useRoomConnectionState();
  const previous = useRef(state);
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    const was = previous.current;
    previous.current = state;
    if (state === 'connected' && was === 'reconnecting') {
      setResumed(true);
      const timer = setTimeout(() => setResumed(false), resumedDurationMs);
      return () => clearTimeout(timer);
    }
    if (state !== 'connected') setResumed(false);
    return undefined;
  }, [state, resumedDurationMs]);

  if (state === 'reconnecting') {
    return (
      <Toast {...rest} kind="warning" busy>
        {messages.reconnecting ?? 'Reconnecting…'}
      </Toast>
    );
  }
  if (state === 'connected' && resumed) {
    return (
      <Toast {...rest} kind="success">
        {messages.resumed ?? 'Connection restored'}
      </Toast>
    );
  }
  if (state === 'failed') {
    return (
      <Toast {...rest} kind="error">
        {messages.failed ?? 'Connection failed'}
      </Toast>
    );
  }
  if (state === 'disconnected' && disconnectReason && disconnectReason !== 'CLIENT_INITIATED') {
    return (
      <Toast {...rest} kind="error" data-reason={disconnectReason}>
        {messages.disconnected?.(disconnectReason) ?? DISCONNECT_REASON_MESSAGES[disconnectReason] ?? 'Disconnected'}
      </Toast>
    );
  }
  return null;
}
