'use client';

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { ChatClientConfig, SwalvoChatError } from '@swalvo/chat';
import { SwalvoChatStoreContext } from './chat-context';
import { SwalvoChatStore } from './chat-store';

export interface SwalvoChatProps extends ChatClientConfig {
  /** Conversation to join: a `conv_...` id, its name, or an attached RTC room id. */
  room: string;
  /** How many messages of history to load on connect. Defaults to 50. */
  historyLimit?: number;
  /**
   * Defaults to `true`: connects on mount, disconnects on unmount. Set
   * `false` to drive `connect()` and `disconnect()` yourself through
   * `useChat()`.
   */
  autoConnect?: boolean;
  /** Rendered instead of `children` while connecting, or if the connection failed. */
  fallback?: ReactNode;
  onError?: (error: SwalvoChatError) => void;
  children?: ReactNode;
}

/**
 * The provider every chat hook needs.
 *
 * Mirrors `<SwalvoRoom>` from the RTC side: same lifecycle, same
 * autoConnect, fallback and onError props. Anyone already using
 * `@swalvo/react` for video has nothing new to learn (spec §43).
 *
 * The two nest quite happily:
 *
 * ```tsx
 * <SwalvoRoom token={rtc.token} endpoint={rtc.endpoint} room={rtc.roomName}>
 *   <SwalvoChat token={chat.token} apiUrl={chat.apiUrl} room={chat.roomId}>
 *     <VideoGrid />
 *     <ChatPanel />
 *   </SwalvoChat>
 * </SwalvoRoom>
 * ```
 *
 * Client-only. Never render this from a Server Component.
 */
export function SwalvoChat({
  room,
  historyLimit = 50,
  autoConnect = true,
  fallback,
  onError,
  children,
  ...config
}: SwalvoChatProps) {
  const storeRef = useRef<SwalvoChatStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new SwalvoChatStore();
    storeRef.current.init(config);
  }
  const store = storeRef.current;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Token and room are read once at mount. A chat token is minted for one
  // user and one set of conversations, so swapping it mid-flight changes
  // who this component *is*. To switch, remount with
  // <SwalvoChat key={token}>. Same one-shot model <SwalvoRoom> uses.
  useEffect(() => {
    if (!autoConnect) return undefined;

    store.connect(room, historyLimit).catch((error: unknown) => {
      onError?.(error as SwalvoChatError);
    });

    return () => {
      store.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);

  const notReady =
    autoConnect &&
    (snapshot.connectionState === 'idle' ||
      snapshot.connectionState === 'connecting' ||
      snapshot.connectionState === 'failed');

  return (
    <SwalvoChatStoreContext.Provider value={store}>
      {notReady && fallback ? fallback : children}
    </SwalvoChatStoreContext.Provider>
  );
}
