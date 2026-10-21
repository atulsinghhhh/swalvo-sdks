'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import type { ChatClient } from '@swalvo/chat';
import { SwalvoChatStoreContext } from '../chat-context';
import { SwalvoChatStore } from '../chat-store';
import { SwalvoChat, type SwalvoChatProps } from '../swalvo-chat';

export interface ChatProviderClientProps {
  /**
   * A `ChatClient` your app created and connected itself. The provider
   * never connects or disconnects it, so its lifetime stays yours — share
   * one client between several providers, or keep it alive across routes.
   */
  client: ChatClient;
  children?: ReactNode;
}

export type ChatProviderProps = ChatProviderClientProps | SwalvoChatProps;

/**
 * The provider the UI kit's components and every chat hook read from.
 *
 * Two ways in:
 *
 * ```tsx
 * // Let the provider own the connection (exactly <SwalvoChat>):
 * <ChatProvider token={grant.token} apiUrl={grant.apiUrl} room="conv_123">…</ChatProvider>
 *
 * // Or hand it a client you already connected:
 * <ChatProvider client={chat}>…</ChatProvider>
 * ```
 *
 * Renders no DOM of its own. Client-only.
 */
export function ChatProvider(props: ChatProviderProps) {
  if ('client' in props && props.client) {
    return <ExistingClientProvider client={props.client}>{props.children}</ExistingClientProvider>;
  }
  return <SwalvoChat {...(props as SwalvoChatProps)} />;
}

function ExistingClientProvider({ client, children }: ChatProviderClientProps) {
  const storeRef = useRef<{ store: SwalvoChatStore; client: ChatClient } | null>(null);
  if (!storeRef.current || storeRef.current.client !== client) {
    const store = new SwalvoChatStore();
    store.adopt(client);
    storeRef.current = { store, client };
  }
  const store = storeRef.current.store;

  useEffect(() => {
    // Re-adopt on (Strict Mode re-)mount: the cleanup below detached it.
    store.adopt(client);
    return () => store.detachExisting();
  }, [store, client]);

  return <SwalvoChatStoreContext.Provider value={store}>{children}</SwalvoChatStoreContext.Provider>;
}
