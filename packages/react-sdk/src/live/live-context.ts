'use client';

import { createContext, useContext } from 'react';
import type { LiveStream, LiveStreamRole } from '@swalvo/live';

export type SwalvoLiveStreamStatus = 'connecting' | 'ready' | 'failed';

export interface SwalvoLiveStreamContextValue {
  status: SwalvoLiveStreamStatus;
  streamId: string;
  role: LiveStreamRole;
  /** `true` for HOST and CO_HOST. The SDK never infers this; it's only ever what the credentials said. */
  isHost: boolean;
  /** The underlying `LiveStream`, once joined, for whatever the hooks below don't cover. */
  stream?: LiveStream;
  error?: unknown;
  leave(): Promise<void>;
  react(emoji: string): Promise<void>;
}

export const SwalvoLiveStreamContext = createContext<SwalvoLiveStreamContextValue | null>(null);

export function useSwalvoLiveStreamContext(): SwalvoLiveStreamContextValue {
  const value = useContext(SwalvoLiveStreamContext);
  if (!value) {
    throw new Error(
      '@swalvo/react Live Streaming hooks must be used inside a <SwalvoLiveStream>; see docs/sdk/react.md#live-streaming.',
    );
  }
  return value;
}
