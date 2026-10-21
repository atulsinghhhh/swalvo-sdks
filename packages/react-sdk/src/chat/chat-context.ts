'use client';

import { createContext, useContext } from 'react';
import { SwalvoChatStore } from './chat-store';

export const SwalvoChatStoreContext = createContext<SwalvoChatStore | null>(null);

export function useSwalvoChatStore(): SwalvoChatStore {
  const store = useContext(SwalvoChatStoreContext);
  if (!store) {
    throw new Error('@swalvo/react chat hooks must be used inside a <SwalvoChat>; see docs/sdk/chat.md#react.');
  }
  return store;
}

/**
 * Kept apart from the RTC store's context on purpose.
 *
 * A page can render `<SwalvoRoom>` and `<SwalvoChat>` side by side, a video
 * call with a chat panel, and neither provider should be able to satisfy
 * the other's hooks by accident (spec §45, independent SDKs that work
 * together).
 */
