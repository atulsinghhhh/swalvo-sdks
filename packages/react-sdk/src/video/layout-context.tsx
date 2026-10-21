'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { isSameTrackReference, type TrackReference } from './types';

/**
 * UI state that belongs to a call screen rather than to the room: which
 * tile is pinned, and whether the chat panel is open. `<VideoConference>`
 * provides it; wrap your own layout in `<LayoutContextProvider>` to get
 * pinning and the chat toggle in a custom one.
 */
export interface LayoutContextValue {
  pinned?: TrackReference;
  pin(ref: TrackReference): void;
  unpin(): void;
  chat: {
    /** A chat panel is wired up, so a toggle makes sense. */
    available: boolean;
    open: boolean;
    setOpen(open: boolean): void;
  };
}

export const LayoutContext = /* @__PURE__ */ createContext<LayoutContextValue | null>(null);

export interface LayoutContextProviderProps {
  /** Whether there is a chat panel for `useChatToggle()` to open. */
  chatAvailable?: boolean;
  defaultChatOpen?: boolean;
  /** Controlled chat state. */
  chatOpen?: boolean;
  onChatOpenChange?: (open: boolean) => void;
  onPinChange?: (pinned: TrackReference | undefined) => void;
  children?: ReactNode;
}

export function LayoutContextProvider({
  chatAvailable = false,
  defaultChatOpen = false,
  chatOpen,
  onChatOpenChange,
  onPinChange,
  children,
}: LayoutContextProviderProps) {
  const [pinned, setPinned] = useState<TrackReference>();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultChatOpen);
  const open = chatOpen ?? uncontrolledOpen;

  const pin = useCallback(
    (ref: TrackReference) => {
      setPinned(ref);
      onPinChange?.(ref);
    },
    [onPinChange],
  );
  const unpin = useCallback(() => {
    setPinned(undefined);
    onPinChange?.(undefined);
  }, [onPinChange]);
  const setOpen = useCallback(
    (next: boolean) => {
      if (chatOpen === undefined) setUncontrolledOpen(next);
      onChatOpenChange?.(next);
    },
    [chatOpen, onChatOpenChange],
  );

  const value = useMemo<LayoutContextValue>(
    () => ({ pinned, pin, unpin, chat: { available: chatAvailable, open, setOpen } }),
    [pinned, pin, unpin, chatAvailable, open, setOpen],
  );
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

/** The layout context, or `null` outside a provider. */
export function useLayoutContext(): LayoutContextValue | null {
  return useContext(LayoutContext);
}

/**
 * The pinned tile (at most one) as a list, plus `pin`/`unpin`/`isPinned`.
 * Outside a layout provider it is always empty and pinning does nothing.
 */
export function usePinnedTracks(): {
  pinned: TrackReference[];
  pin(ref: TrackReference): void;
  unpin(): void;
  isPinned(ref: TrackReference): boolean;
} {
  const layout = useLayoutContext();
  const pinnedRef = layout?.pinned;
  const pin = layout?.pin;
  const unpin = layout?.unpin;
  return useMemo(
    () => ({
      pinned: pinnedRef ? [pinnedRef] : [],
      pin: (ref: TrackReference) => pin?.(ref),
      unpin: () => unpin?.(),
      isPinned: (ref: TrackReference) => isSameTrackReference(pinnedRef, ref),
    }),
    [pinnedRef, pin, unpin],
  );
}

/**
 * The chat panel's open state, for a custom toggle. `available` is false
 * when no chat panel was given to `<VideoConference chat={…}>`.
 */
export function useChatToggle(): { available: boolean; open: boolean; toggle(): void; setOpen(open: boolean): void } {
  const layout = useLayoutContext();
  const chat = layout?.chat;
  return useMemo(
    () => ({
      available: chat?.available ?? false,
      open: chat?.open ?? false,
      toggle: () => chat?.setOpen(!chat.open),
      setOpen: (open: boolean) => chat?.setOpen(open),
    }),
    [chat],
  );
}
