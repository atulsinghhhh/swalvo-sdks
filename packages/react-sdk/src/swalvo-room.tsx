'use client';

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { RTCClientConfig, RTCError } from '@swalvo/rtc';
import { SwalvoStoreContext } from './context';
import { SwalvoStore } from './store';

export interface SwalvoRoomProps extends RTCClientConfig {
  /** The room to join. Required whenever `autoConnect` (the default) is true. */
  room: string;
  /**
   * Defaults to `true`: joins on mount, leaves on unmount. Set `false` to
   * drive `join()` and `leave()` yourself through `useSwalvo()`, say to join
   * only once the user clicks something.
   */
  autoConnect?: boolean;
  /** Rendered instead of `children` while the initial join is in flight, or if it fails. */
  fallback?: ReactNode;
  onError?: (error: RTCError) => void;
  children?: ReactNode;
}

/**
 * The provider every `@swalvo/react` hook and component needs. Also
 * usable directly as the "SwalvoRoom" primitive from the Phase 11 spec.
 *
 * Owns exactly one `RTCClient` and `Room` for its whole lifetime, and
 * unmounting it always calls `leave()`. So tearing down a video call UI is
 * just a matter of unmounting this component.
 *
 * Client-only. Never render it from a Server Component (see
 * docs/sdk/react.md#nextjs).
 */
export function SwalvoRoom({
  room: roomId,
  autoConnect = true,
  fallback,
  onError,
  children,
  ...config
}: SwalvoRoomProps) {
  const storeRef = useRef<SwalvoStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new SwalvoStore();
    storeRef.current.init(config);
  }
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);

  // `room`, token and the rest are read once at mount and pointedly not
  // re-applied on change. An RTC token is minted for exactly one join, the
  // same one-shot model @swalvo/rtc itself uses. To swap the token,
  // remount <SwalvoRoom key={token}> with a fresh one.
  useEffect(() => {
    if (!autoConnect) return undefined;

    store.join(roomId).catch((error: unknown) => {
      onError?.(error as RTCError);
    });

    return () => {
      store.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);

  const isConnectingOrFailed =
    autoConnect &&
    (snapshot.connectionState === 'idle' ||
      snapshot.connectionState === 'connecting' ||
      snapshot.connectionState === 'failed');

  return (
    <SwalvoStoreContext.Provider value={store}>
      {isConnectingOrFailed ? (fallback ?? null) : children}
    </SwalvoStoreContext.Provider>
  );
}
