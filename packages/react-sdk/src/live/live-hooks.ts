'use client';

import type { LiveStream, LiveStreamRole } from '@swalvo/live';
import { useCamera, useMicrophone } from '../hooks';
import { useSwalvoLiveStreamContext, type SwalvoLiveStreamStatus } from './live-context';

/**
 * Live Streaming hooks for `@swalvo/react`.
 *
 * You'll notice there's no `useLiveStreamParticipants()` or
 * `useLiveStreamChat()`. That's deliberate. A stream's participants and
 * chat are a `@swalvo/rtc` roster and a `@swalvo/chat` conversation
 * like any other, so `useParticipants()`, `useMessages()`,
 * `useReactions()` and every other existing `@swalvo/react` hook already
 * work inside a `<SwalvoLiveStream>`. Adding parallel names for the same
 * data is exactly the "separate chat/RTC implementation for streaming" the
 * spec tells us not to build.
 */

export interface UseLiveStreamResult {
  status: SwalvoLiveStreamStatus;
  streamId: string;
  role: LiveStreamRole;
  isHost: boolean;
  stream?: LiveStream;
  error?: unknown;
  leave(): Promise<void>;
  react(emoji: string): Promise<void>;
}

/** The full picture: connection status, role, and the two actions every stream wants. */
export function useLiveStream(): UseLiveStreamResult {
  return useSwalvoLiveStreamContext();
}

export function useLiveStreamRole(): { role: LiveStreamRole; isHost: boolean } {
  const { role, isHost } = useSwalvoLiveStreamContext();
  return { role, isHost };
}

/** The underlying `LiveStream`, once joined, for whatever the hooks don't cover. */
export function useLiveStreamClient(): LiveStream | undefined {
  return useSwalvoLiveStreamContext().stream;
}

export interface UseLiveStreamHostResult extends UseLiveStreamResult {
  camera: ReturnType<typeof useCamera>;
  microphone: ReturnType<typeof useMicrophone>;
}

/**
 * The host and co-host experience: everything `useLiveStream()` has, plus
 * camera and microphone control.
 *
 * Throws if called on a VIEWER-role stream. A viewer's RTC token carries no
 * publish grant, so offering camera and mic controls here would put a
 * button on screen that can only ever fail.
 */
export function useLiveStreamHost(): UseLiveStreamHostResult {
  const stream = useLiveStream();
  const camera = useCamera();
  const microphone = useMicrophone();

  if (!stream.isHost) {
    throw new Error('useLiveStreamHost() was called for a VIEWER-role stream; use useLiveStreamViewer() instead.');
  }

  return { ...stream, camera, microphone };
}

/**
 * The viewer experience: everything `useLiveStream()` has.
 *
 * Throws on a HOST or CO_HOST stream, symmetrically with
 * `useLiveStreamHost()`. Pick the hook matching the role your backend
 * minted instead of branching on `isHost` yourself.
 */
export function useLiveStreamViewer(): UseLiveStreamResult {
  const stream = useLiveStream();

  if (stream.isHost) {
    throw new Error(
      'useLiveStreamViewer() was called for a HOST/CO_HOST-role stream; use useLiveStreamHost() instead.',
    );
  }

  return stream;
}
