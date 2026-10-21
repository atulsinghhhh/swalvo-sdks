'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { joinLiveStream, type LiveStream, type LiveStreamCredentials } from '@swalvo/live';
import { SwalvoStoreContext } from '../context';
import { SwalvoStore } from '../store';
import { SwalvoChatStoreContext } from '../chat/chat-context';
import { SwalvoChatStore } from '../chat/chat-store';
import {
  SwalvoLiveStreamContext,
  type SwalvoLiveStreamContextValue,
  type SwalvoLiveStreamStatus,
} from './live-context';

export interface SwalvoLiveStreamProps {
  /** Minted server-side by `addHost()` or `createViewerToken()`. Never build one by hand. */
  credentials: LiveStreamCredentials;
  /** How many messages of live chat history to load once connected. Defaults to 50. */
  historyLimit?: number;
  /** Rendered instead of `children` while connecting, or if the connection failed. */
  fallback?: ReactNode;
  onError?: (error: unknown) => void;
  children?: ReactNode;
}

/**
 * The provider every Live Streaming hook needs.
 *
 * Mounts the *same* `SwalvoStoreContext` and `SwalvoChatStoreContext` that
 * `<SwalvoRoom>` and `<SwalvoChat>` use, on purpose. A stream's `room` and
 * `chat` are precisely a `@swalvo/rtc` `Room` and a `@swalvo/chat`
 * `ChatClient`, so every existing hook already works inside a
 * `<SwalvoLiveStream>`: `useParticipants`, `useCamera`, `useMicrophone`,
 * `useMessages`, `useReactions`, `useTyping`, the lot. Nothing here
 * reimplements participants or chat.
 *
 * Client-only. Never render this from a Server Component.
 */
export function SwalvoLiveStream({
  credentials,
  historyLimit = 50,
  fallback,
  onError,
  children,
}: SwalvoLiveStreamProps) {
  const rtcStoreRef = useRef<SwalvoStore | null>(null);
  const chatStoreRef = useRef<SwalvoChatStore | null>(null);
  if (!rtcStoreRef.current) rtcStoreRef.current = new SwalvoStore();
  if (!chatStoreRef.current) chatStoreRef.current = new SwalvoChatStore();
  const streamRef = useRef<LiveStream | undefined>(undefined);
  // Chains every invocation of the effect below to the previous one's full
  // teardown. Persists across a mount→cleanup→mount cycle because refs
  // survive that (only the effect body and its closure re-run) — see the
  // comment inside the effect for why this exists.
  const settleChainRef = useRef<Promise<void>>(Promise.resolve());

  const [state, setState] = useState<{ status: SwalvoLiveStreamStatus; stream?: LiveStream; error?: unknown }>({
    status: 'connecting',
  });

  // Credentials are read once at mount, the same one-shot model
  // <SwalvoRoom> and <SwalvoChat> use. A stream credential is minted for one
  // identity and one role, so swapping it mid-flight changes who this
  // component *is*. To switch, remount with
  // <SwalvoLiveStream key={credentials.streamId}>.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'connecting' });

    // React (Strict Mode, in development) mounts this effect, runs its
    // cleanup, then mounts it again — synchronously, before the first
    // `joinLiveStream()` call has resolved. Without the chaining below, the
    // second invocation's `joinLiveStream()` starts while the first's is
    // still in flight for the *same identity*, and the server briefly has
    // two live sessions claiming to be the same participant. Whichever one
    // loses that race can end up as a room the UI never receives
    // `participantJoined`/`trackSubscribed` for, even though its
    // `RTCPeerConnection` completes ICE and genuinely receives media —
    // media flows, but no participant ever appears.
    //
    // Chaining onto `settleChainRef` (which persists across the
    // mount→cleanup→mount cycle, unlike any effect-local variable) makes
    // this invocation's own `joinLiveStream()` wait for the *previous*
    // invocation's full settle — including its own `leave()`, if it was
    // already cancelled by the time it resolved — before calling
    // `joinLiveStream()` at all. At most one join is ever in flight or
    // active for this component instance.
    const previous = settleChainRef.current;
    const thisRun = previous
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return;
        const stream = await joinLiveStream(credentials);
        streamRef.current = stream;
        if (cancelled) return; // cleanup already ran; its chained leave() below tears this down
        rtcStoreRef.current!.attachExisting(stream.room, stream.rtc);
        if (stream.chat && credentials.chat) {
          await chatStoreRef.current!.attachExisting(stream.chat, credentials.chat.conversations[0], historyLimit);
        }
        if (cancelled) return;
        setState({ status: 'ready', stream });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'failed', error });
          onError?.(error);
        }
      });

    return () => {
      cancelled = true;
      // detachExisting(), not dispose(). The leave() chained below already
      // tears down the underlying RTC and chat connections, and dispose()
      // would leave and disconnect them all over again.
      rtcStoreRef.current?.detachExisting();
      chatStoreRef.current?.detachExisting();
      // Exactly one place calls stream.leave(): here, after this
      // invocation's own join settles (successfully or not). A subsequent
      // invocation's `joinLiveStream()` (via `previous.then(...)` above)
      // won't start until this promise resolves.
      settleChainRef.current = thisRun
        .catch(() => undefined)
        .then(() => {
          const stream = streamRef.current;
          streamRef.current = undefined;
          return stream?.leave();
        })
        .then(() => undefined)
        .catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials.streamId]);

  const contextValue: SwalvoLiveStreamContextValue = useMemo(
    () => ({
      status: state.status,
      streamId: credentials.streamId,
      role: credentials.role,
      isHost: credentials.role === 'HOST' || credentials.role === 'CO_HOST',
      stream: state.stream,
      error: state.error,
      leave: async () => {
        await streamRef.current?.leave();
      },
      react: async (emoji: string) => {
        if (!streamRef.current) return;
        await streamRef.current.react(emoji);
      },
    }),
    [state, credentials.streamId, credentials.role],
  );

  const notReady = state.status !== 'ready';

  return (
    <SwalvoLiveStreamContext.Provider value={contextValue}>
      <SwalvoStoreContext.Provider value={rtcStoreRef.current}>
        <SwalvoChatStoreContext.Provider value={chatStoreRef.current}>
          {notReady ? (fallback ?? null) : children}
        </SwalvoChatStoreContext.Provider>
      </SwalvoStoreContext.Provider>
    </SwalvoLiveStreamContext.Provider>
  );
}
